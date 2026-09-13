'use client';

import { useCallback, useEffect, useState } from 'react';

type EthereumProvider = {
  on?: (event: 'accountsChanged', listener: (accounts: string[]) => void) => void;
  removeListener?: (event: 'accountsChanged', listener: (accounts: string[]) => void) => void;
  request: (request: { method: string }) => Promise<unknown>;
};

declare global {
  interface Window {
    ethereum?: EthereumProvider;
  }
}

function shorten(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function WalletIdentity({ expectedOwner }: { expectedOwner: string }) {
  const [account, setAccount] = useState<string>();
  const [message, setMessage] = useState('Connect the owner wallet to compare its address.');

  const receiveAccounts = useCallback(
    (accounts: string[]) => {
      const nextAccount = accounts[0];
      setAccount(nextAccount);
      if (!nextAccount) {
        setMessage('No wallet account is connected.');
      } else if (nextAccount.toLowerCase() === expectedOwner.toLowerCase()) {
        setMessage('This wallet matches the owner in the recorded mandate.');
      } else {
        setMessage('This wallet does not match the owner in the recorded mandate.');
      }
    },
    [expectedOwner],
  );

  useEffect(() => {
    const provider = window.ethereum;
    if (!provider?.on) return;
    provider.on('accountsChanged', receiveAccounts);
    return () => provider.removeListener?.('accountsChanged', receiveAccounts);
  }, [receiveAccounts]);

  async function connect() {
    if (!window.ethereum) {
      setMessage('No browser wallet was found. The public evidence remains available below.');
      return;
    }

    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
      receiveAccounts(Array.isArray(accounts) ? accounts.map(String) : []);
    } catch {
      setMessage('Wallet connection was cancelled or unavailable. Nothing was signed.');
    }
  }

  const matches = account?.toLowerCase() === expectedOwner.toLowerCase();

  return (
    <div className="wallet-identity">
      <div>
        <span className="eyebrow">Owner check</span>
        <p
          aria-live="polite"
          className={matches ? 'wallet-message wallet-match' : 'wallet-message'}
          role="status"
        >
          {message}
        </p>
      </div>
      <button className="secondary-button" type="button" onClick={connect}>
        {account ? shorten(account) : 'Connect wallet'}
      </button>
    </div>
  );
}
