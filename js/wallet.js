// Pinned to the 8.x line: from 9.x the MyNearWallet module opens the wallet in a popup
// and waits for it, which strands users whose popup is hidden or errors; 8.x redirects.
import { setupWalletSelector } from 'https://esm.sh/@near-wallet-selector/core@8.10.2';
import { setupModal } from 'https://esm.sh/@near-wallet-selector/modal-ui-js@8.10.2';
import { setupMyNearWallet } from 'https://esm.sh/@near-wallet-selector/my-near-wallet@8.10.2';
import { setupMeteorWallet } from 'https://esm.sh/@near-wallet-selector/meteor-wallet@8.10.2';

try {
  const selector = await setupWalletSelector({
    network: { networkId: 'testnet', nodeUrl: RPCS[0], helperUrl: 'https://helper.testnet.near.org',
      explorerUrl: EXPLORER, indexerUrl: 'https://testnet-api.kitwallet.app' },
    modules: [setupMyNearWallet(), setupMeteorWallet()],
  });
  // `place_bet` is the only method a player calls, and its deposit means the
  // wallet approves every one: a function-call key cannot attach NEAR.
  const modal = setupModal(selector, { contractId: CONTRACT, methodNames: ['place_bet'] });
  const sync = state => setAccount((state.accounts.find(a => a.active) || {}).accountId || null);
  walletApi = {
    show: async () => modal.show(),
    signOut: async () => (await selector.wallet()).signOut(),
    bet: async (numbers, game_id, deposit) => (await selector.wallet()).signAndSendTransaction({
      receiverId: CONTRACT,
      actions: [{ type: 'FunctionCall', params: { methodName: 'place_bet', args: { numbers, game_id }, gas: GAS, deposit } }],
    }),
  };
  sync(selector.store.getState());
  selector.store.observable.subscribe(sync);
} catch (e) {
  toast('Wallet selector failed to load: ' + e.message, true);
  $('connect').disabled = true;
}
