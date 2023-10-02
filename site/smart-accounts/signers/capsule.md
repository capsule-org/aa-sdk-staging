---
outline: deep
head:
  - - meta
    - property: og:title
      content: Capsule
  - - meta
    - name: description
      content: Guide to use Capsule as a signer
  - - meta
    - property: og:description
      content: Guide to use Capsule as a signer
---

# Capsule

[Capsule](https://usecapsule.com/) is a signing solution that you can use to create secure embedded MPC wallets with just an email or social login that are recoverable, portable, and permissioned across different crypto applications, so your users don't need to create different signers or contract accounts for every app they use.

Combining Capsule with Account Kit allows you to get the best of both on and off-chain programmability. You can use Capsule to create a wallet that works across apps, and then connect it to Account Kit to create expressive Smart Contract Accounts for your users!

# Integration

Getting started with Capsule is easy-- simply get access to the SDK and an API key by filling out [this form](https://form.typeform.com/to/hLaJeYJW). From there, if you're adding additional permissions or automation and would like deeper support, please refer to our [full developer docs](https://docs.usecapsule.com) or get in touch via hello@usecapsule.com

### Install the SDK

Web
::: code-group

```bash [npm]
npm i -s @usecapsule/web-sdk
```

```bash [yarn]
yarn add @usecapsule/web-sdk
```

:::

React Native
::: code-group

```bash [npm]
npm i -s @usecapsule/react-native-sdk
```

```bash [yarn]
yarn add @usecapsule/react-native-sdk
```

:::

### Create a SmartAccountSigner

Next, setup the Capsule SDK and create a `SmartAccountSigner`

<<< @/snippets/capsule.ts

### Use it with LightAccount

Let's see it in action with `aa-alchemy` and `LightSmartContractAccount` from `aa-accounts`:
::: code-group

```ts [example.ts]
import { AlchemyProvider } from "@alchemy/aa-alchemy";
import { LightSmartContractAccount } from "@alchemy/aa-accounts";
import { sepolia } from "viem/chains";
import { capsuleSigner } from "./capsule";

const chain = sepolia;
const provider = new AlchemyProvider({
  apiKey: "ALCHEMY_API_KEY",
  chain,
  entryPointAddress: "0x...",
}).connect(
  (rpcClient) =>
    new LightSmartContractAccount({
      entryPointAddress: "0x...",
      chain: rpcClient.chain,
      owner: capsuleSigner,
      factoryAddress: "0x...",
      rpcClient,
    })
);
```

<<< @/snippets/capsule.ts

:::
