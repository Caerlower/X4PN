import {
  SupportedWallet,
  WalletId,
  WalletManager,
  WalletProvider,
  useWallet,
} from '@txnlab/use-wallet-react';
import App from './App';

const algodServer = import.meta.env.VITE_ALGOD_SERVER || 'https://testnet-api.algonode.cloud';
const algodPort = import.meta.env.VITE_ALGOD_PORT || '443';
const algodToken = import.meta.env.VITE_ALGOD_TOKEN || '';
const network = import.meta.env.VITE_ALGOD_NETWORK || 'testnet';

const walletManager = new WalletManager({
  wallets: [
    {
      id: WalletId.PERA,
      options: {
        chainId: 416002,
        shouldShowSignTxnToast: true,
      },
    },
    { id: WalletId.DEFLY },
    { id: WalletId.LUTE },
  ] as SupportedWallet[],
  defaultNetwork: network,
  networks: {
    [network]: {
      algod: {
        baseServer: algodServer,
        port: algodPort,
        token: String(algodToken),
      },
    },
  },
  options: { resetNetwork: true },
});

export default function WalletApp() {
  return (
    <WalletProvider manager={walletManager}>
      <App />
    </WalletProvider>
  );
}

export { useWallet };
