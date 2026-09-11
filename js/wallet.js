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
  // Signing in leaves a function-call key for `place_bet` in the browser, so a
  // bet paid from chips (no deposit attached) is signed here without the
  // wallet. Anything that moves NEAR — a deposit, a withdrawal, a bet the chips
  // do not cover — goes to the wallet to approve.
  const modal = setupModal(selector, { contractId: CONTRACT, methodNames: ['place_bet'] });
  const call = async (methodName, args, deposit, gas) => (await selector.wallet()).signAndSendTransaction({
    receiverId: CONTRACT,
    actions: [{ type: 'FunctionCall', params: { methodName, args, gas, deposit } }],
  });
  const sync = state => setAccount((state.accounts.find(a => a.active) || {}).accountId || null);
  walletApi = {
    show: async () => modal.show(),
    signOut: async () => (await selector.wallet()).signOut(),
    bet: (numbers, game_id, amount, deposit) => call('place_bet', { numbers, game_id, amount }, deposit, GAS),
    deposit: amount => call('deposit', {}, amount, BANK_GAS),
    withdraw: () => call('withdraw', {}, '0', BANK_GAS),
  };
  sync(selector.store.getState());
  selector.store.observable.subscribe(sync);
} catch (e) {
  toast('Wallet selector failed to load: ' + e.message, true);
  $('connect').disabled = true;
}
