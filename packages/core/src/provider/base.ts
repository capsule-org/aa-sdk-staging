import {
  fromHex,
  type Address,
  type Chain,
  type Hash,
  type RpcTransactionRequest,
  type Transport,
} from "viem";
import { BaseSmartContractAccount } from "../account/base.js";
import { createPublicErc4337Client } from "../client/create-client.js";
import type {
  PublicErc4337Client,
  SupportedTransports,
} from "../client/types.js";
import { isValidRequest, type UserOperationStruct } from "../types.js";
import {
  asyncPipe,
  deepHexlify,
  getUserOperationHash,
  resolveProperties,
} from "../utils.js";
import type {
  AccountMiddlewareFn,
  ISmartAccountProvider,
  SendUserOperationResult,
} from "./types.js";

export const noOpMiddleware: AccountMiddlewareFn = async (
  struct: UserOperationStruct
) => struct;

// borrowed from ethers.js
function defineReadOnly<T, K extends keyof T>(
  object: T,
  key: K,
  value: T[K]
): void {
  Object.defineProperty(object, key, {
    enumerable: true,
    value: value,
    writable: false,
  });
}

export interface SmartAccountProviderOpts {
  /**
   * The maximum number of times tot try fetching a transaction receipt before giving up
   */
  txMaxRetries?: number;

  /**
   * The interval in milliseconds to wait between retries while waiting for tx receipts
   */
  txRetryIntervalMs?: number;

  /**
   * used when computing the fees for a user operation (default: 1000000000n)
   */
  minPriorityFeePerBid?: bigint;
}

export class SmartAccountProvider<
  TTransport extends SupportedTransports = Transport
> implements ISmartAccountProvider<TTransport>
{
  private txMaxRetries: number;
  private txRetryIntervalMs: number;
  private minPriorityFeePerBid: bigint;
  rpcClient: PublicErc4337Client<Transport>;

  constructor(
    rpcProvider: string | PublicErc4337Client<TTransport>,
    private entryPointAddress: Address,
    private chain: Chain,
    readonly account?: BaseSmartContractAccount,
    opts?: SmartAccountProviderOpts
  ) {
    this.txMaxRetries = opts?.txMaxRetries ?? 5;
    this.txRetryIntervalMs = opts?.txRetryIntervalMs ?? 2000;
    this.minPriorityFeePerBid = opts?.minPriorityFeePerBid ?? 1000000000n;
    this.rpcClient =
      typeof rpcProvider === "string"
        ? createPublicErc4337Client({
            chain,
            rpcUrl: rpcProvider,
          })
        : rpcProvider;
  }

  request: (args: { method: string; params?: any[] }) => Promise<any> = async (
    args
  ) => {
    const { method, params } = args;
    switch (method) {
      case "eth_sendTransaction":
        const [tx] = params as [RpcTransactionRequest];
        return this.sendTransaction(tx);
      // TODO: will probably need to handle typed message signing too?
      case "eth_sign":
      case "personal_sign":
        if (!this.account) {
          throw new Error("account not connected!");
        }

        const [data, address] = params!;
        if (address !== (await this.getAddress())) {
          throw new Error(
            "cannot sign for address that is not the current account"
          );
        }

        return await this.account.signMessage(data);
      default:
        // TODO: there's probably a number of methods we just don't support, will need to test most of them out
        // first let's get something working though
        // @ts-expect-error the typing with viem clashes here, we'll need to fix the typing on this method
        return this.rpcClient.request(args);
    }
  };

  getAddress = (): Promise<`0x${string}`> => {
    if (!this.account) {
      throw new Error("account not connected!");
    }

    return this.account.getAddress();
  };

  sendTransaction = async (request: RpcTransactionRequest): Promise<Hash> => {
    if (!request.to) {
      throw new Error("transaction is missing to address");
    }

    // TODO: need to add support for overriding gas prices
    const { hash } = await this.sendUserOperation(
      request.to,
      request.data ?? "0x",
      request.value ? fromHex(request.value, "bigint") : 0n
    );

    return await this.waitForUserOperationTransaction(hash as Hash);
  };

  private async waitForUserOperationTransaction(hash: Hash): Promise<Hash> {
    for (let i = 0; i < this.txMaxRetries; i++) {
      await new Promise((resolve) =>
        setTimeout(resolve, this.txRetryIntervalMs)
      );
      const receipt = await this.rpcClient
        .getUserOperationReceipt(hash as `0x${string}`)
        // TODO: should maybe log the error?
        .catch(() => null);
      if (receipt) {
        return this.rpcClient
          .getTransaction({ hash: receipt.receipt.transactionHash })
          .then((x) => x.hash);
      }
    }

    throw new Error("Failed to find transaction for User Operation");
  }

  sendUserOperation = async (
    target: string,
    data: string,
    value?: bigint | undefined
  ): Promise<SendUserOperationResult> => {
    if (!this.account) {
      throw new Error("account not connected!");
    }

    const initCode = await this.account.getInitCode();
    const uoStruct = await asyncPipe(
      this.dummyPaymasterDataMiddleware,
      this.gasEstimator,
      this.feeDataGetter,
      this.paymasterMiddleware
    )({
      initCode,
      sender: this.getAddress(),
      nonce: this.account.getNonce(),
      callData: this.account.encodeExecute(target, value ?? 0n, data),
      signature: this.account.getDummySignature(),
    } as UserOperationStruct);

    const request = deepHexlify(await resolveProperties(uoStruct));
    if (!isValidRequest(request)) {
      // this pretty prints the uo
      throw new Error(
        `Request is missing parameters. All properties on UserOperationStruct must be set. uo: ${JSON.stringify(
          request,
          null,
          2
        )}`
      );
    }

    request.signature = (await this.account.signMessage(
      getUserOperationHash(
        request,
        this.entryPointAddress as `0x${string}`,
        BigInt(this.chain.id)
      )
    )) as `0x${string}`;

    return {
      hash: await this.rpcClient.sendUserOperation(
        request,
        this.entryPointAddress
      ),
      request,
    };
  };

  // These are dependent on the specific paymaster being used
  // You should implement your own middleware to override these
  // or extend this class and provider your own implemenation
  readonly dummyPaymasterDataMiddleware: AccountMiddlewareFn = async (
    struct: UserOperationStruct
  ): Promise<UserOperationStruct> => {
    struct.paymasterAndData = "0x";
    return struct;
  };

  readonly paymasterMiddleware: AccountMiddlewareFn = async (
    struct: UserOperationStruct
  ): Promise<UserOperationStruct> => {
    struct.paymasterAndData = "0x";

    return struct;
  };

  readonly gasEstimator: AccountMiddlewareFn = async (struct) => {
    const request = deepHexlify(await resolveProperties(struct));
    const estimates = await this.rpcClient.estimateUserOperationGas(
      request,
      this.entryPointAddress
    );

    struct.callGasLimit = estimates.callGasLimit;
    struct.verificationGasLimit = estimates.verificationGasLimit;
    struct.preVerificationGas = estimates.preVerificationGas;

    return struct;
  };

  readonly feeDataGetter: AccountMiddlewareFn = async (struct) => {
    const maxPriorityFeePerGas = await this.rpcClient.getMaxPriorityFeePerGas();
    const feeData = await this.rpcClient.getFeeData();
    if (!feeData.maxFeePerGas || !feeData.maxPriorityFeePerGas) {
      throw new Error(
        "feeData is missing maxFeePerGas or maxPriorityFeePerGas"
      );
    }

    // add 33% to the priorty fee to ensure the transaction is mined
    let maxPriorityFeePerGasBid = (BigInt(maxPriorityFeePerGas) * 4n) / 3n;
    if (maxPriorityFeePerGasBid < this.minPriorityFeePerBid) {
      maxPriorityFeePerGasBid = this.minPriorityFeePerBid;
    }

    const maxFeePerGasBid =
      BigInt(feeData.maxFeePerGas) -
      BigInt(feeData.maxPriorityFeePerGas) +
      maxPriorityFeePerGasBid;

    struct.maxFeePerGas = maxFeePerGasBid;
    struct.maxPriorityFeePerGas = maxPriorityFeePerGasBid;

    return struct;
  };

  withPaymasterMiddleware = (overrides: {
    dummyPaymasterMiddleware?: AccountMiddlewareFn;
    getPaymasterAndDataMiddleware?: AccountMiddlewareFn;
  }): this => {
    defineReadOnly(
      this,
      "dummyPaymasterDataMiddleware",
      overrides.dummyPaymasterMiddleware ?? this.dummyPaymasterDataMiddleware
    );
    defineReadOnly(
      this,
      "paymasterMiddleware",
      overrides.getPaymasterAndDataMiddleware ?? this.paymasterMiddleware
    );

    return this;
  };

  withGasEstimator = (override: AccountMiddlewareFn): this => {
    defineReadOnly(this, "gasEstimator", override);
    return this;
  };

  withFeeDataGetter = (override: AccountMiddlewareFn): this => {
    defineReadOnly(this, "feeDataGetter", override);
    return this;
  };

  connect(
    fn: (provider: PublicErc4337Client<TTransport>) => BaseSmartContractAccount
  ): this & { account: BaseSmartContractAccount } {
    const account = fn(this.rpcClient);
    defineReadOnly(this, "account", account);
    return this as this & { account: typeof account };
  }
}