import Image from 'next/image';
import type { ReactNode } from 'react';

import transactionProof from '../../../../evidence/day-3/transaction-proof.jpg';
import { WalletIdentity } from '@/app/_components/wallet-identity';
import {
  dayThreeEvidence as evidence,
  explorerAddress,
  explorerTransaction,
} from '@/data/day-three';

function ExternalLink({ href, children }: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <a className="external-link" href={href} rel="noreferrer" target="_blank">
      {children}
      <span aria-hidden="true">↗</span>
    </a>
  );
}

function AddressLink({ address }: { address: string }) {
  return (
    <ExternalLink href={explorerAddress(address)}>
      <span className="desktop-address">{address}</span>
      <span className="mobile-address">
        {address.slice(0, 8)}…{address.slice(-6)}
      </span>
    </ExternalLink>
  );
}

function VetoMark() {
  return (
    <svg aria-hidden="true" className="veto-mark" viewBox="0 0 42 42">
      <path d="M21 3 37 9v11c0 9.7-6.6 16.1-16 19C11.6 36.1 5 29.7 5 20V9l16-6Z" />
      <path d="m13 20 5 5 11-11" />
    </svg>
  );
}

export default function Home() {
  return (
    <main>
      <header className="site-header">
        <a className="brand" href="#top" aria-label="VETO home">
          <VetoMark />
          <span>VETO</span>
        </a>
        <div className="header-labels">
          <span className="network-dot" aria-hidden="true" />
          {evidence.chain.name}
          <span className="header-separator" aria-hidden="true" />
          Recorded evidence
        </div>
      </header>

      <div className="page-shell" id="top">
        <section className="hero">
          <div>
            <p className="kicker">Verifiable exit operator</p>
            <h1>Your fee rule acted before the change could.</h1>
            <p className="hero-copy">
              A queued 2% management fee crossed the owner&apos;s 1% ceiling. VETO verified the
              exact proposal, then KeeperHub returned the controlled test assets to the owner.
            </p>
          </div>
          <div className="outcome-card" aria-label="Verified exit outcome">
            <span className="status-icon">✓</span>
            <div>
              <span className="eyebrow">Verified result</span>
              <strong>Exit confirmed</strong>
              <small>Block {evidence.result.blockNumber}</small>
            </div>
          </div>
        </section>

        <aside className="truth-banner">
          <span aria-hidden="true">i</span>
          <p>
            <strong>Controlled testnet evidence.</strong> The vault and asset are purpose-built Base
            Sepolia fixtures with no financial value. This is not a Morpho mainnet withdrawal or
            real USDC.
          </p>
        </aside>

        <ol className="timeline" aria-label="Exit lifecycle">
          {['Proposal observed', 'Rule verified', 'KeeperHub submitted', 'Exit confirmed'].map(
            (step, index) => (
              <li key={step}>
                <span>{index + 1}</span>
                <strong>{step}</strong>
              </li>
            ),
          )}
        </ol>

        <section className="dashboard-grid" aria-label="VETO evidence dashboard">
          <article className="panel position-panel">
            <div className="panel-heading">
              <div>
                <span className="step-label">01 · My position</span>
                <h2>What the owner held</h2>
              </div>
              <span className="verified-pill">Factory verified</span>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Vault</dt>
                <dd>
                  <AddressLink address={evidence.position.vault} />
                </dd>
              </div>
              <div>
                <dt>Chain</dt>
                <dd>
                  {evidence.chain.name} <span className="muted">· {evidence.chain.id}</span>
                </dd>
              </div>
              <div>
                <dt>Asset</dt>
                <dd>{evidence.position.assetName}</dd>
              </div>
              <div>
                <dt>Shares before exit</dt>
                <dd>{evidence.position.sharesBefore}</dd>
              </div>
            </dl>
            <WalletIdentity expectedOwner={evidence.position.owner} />
          </article>

          <article className="panel instruction-panel">
            <div className="panel-heading">
              <div>
                <span className="step-label">02 · My instruction</span>
                <h2>The owner&apos;s hard limit</h2>
              </div>
              <span className="consumed-pill">Consumed</span>
            </div>
            <p className="rule-sentence">
              If the management fee goes above <strong>{evidence.instruction.feeCeiling}</strong>,
              redeem exactly <strong>{evidence.instruction.shares} shares</strong> to the owner.
            </p>
            <div className="metric-row">
              <div>
                <span>Minimum return</span>
                <strong>{evidence.instruction.minimumReturn}</strong>
              </div>
              <div>
                <span>Safety window</span>
                <strong>{evidence.instruction.safetyWindow}</strong>
              </div>
            </div>
            <dl className="compact-list">
              <div>
                <dt>Mandate expires</dt>
                <dd>{evidence.instruction.expiresAt}</dd>
              </div>
              <div>
                <dt>Finite share approval</dt>
                <dd>{evidence.instruction.shares} shares · now consumed</dd>
              </div>
              <div>
                <dt>Cancellation</dt>
                <dd>Owner-only before execution · no longer active</dd>
              </div>
            </dl>
          </article>

          <article className="panel change-panel">
            <div className="panel-heading">
              <div>
                <span className="step-label">03 · Change waiting</span>
                <h2>The fee proposal crossed the rule</h2>
              </div>
              <span className="applies-pill">Rule applied</span>
            </div>
            <div className="fee-comparison">
              <div>
                <span>Current fee</span>
                <strong>{evidence.proposal.currentFee}</strong>
              </div>
              <span className="fee-arrow" aria-hidden="true">
                →
              </span>
              <div className="proposed-fee">
                <span>Proposed fee</span>
                <strong>{evidence.proposal.proposedFee}</strong>
              </div>
            </div>
            <p className="plain-explanation">
              The proposed fee is 1 percentage point above the owner&apos;s limit, so this mandate
              applied. The exit landed <strong>{evidence.proposal.leadTime}</strong> before the fee
              could first be executed.
            </p>
            <dl className="compact-list">
              <div>
                <dt>Proposal submitted</dt>
                <dd>{evidence.proposal.submittedAt}</dd>
              </div>
              <div>
                <dt>Earliest fee execution</dt>
                <dd>{evidence.proposal.executableAt}</dd>
              </div>
            </dl>
            <ExternalLink href={explorerTransaction(evidence.proposal.transactionHash)}>
              View the source proposal transaction
            </ExternalLink>
          </article>

          <article className="panel result-panel">
            <div className="panel-heading">
              <div>
                <span className="step-label">04 · Result</span>
                <h2>Funds returned to the owner</h2>
              </div>
              <span className="verified-pill">Receipt checked</span>
            </div>
            <div className="result-number">
              <strong>{evidence.result.assetsReturned}</strong>
              <span>{evidence.position.assetName}</span>
            </div>
            <div className="result-checks">
              <span>✓ Owner shares are {evidence.position.sharesAfter}</span>
              <span>✓ Guard retained {evidence.result.guardAssets}</span>
              <span>✓ Duplicate run made no second claim</span>
            </div>
            <dl className="compact-list result-metadata">
              <div>
                <dt>KeeperHub execution</dt>
                <dd>{evidence.result.executionId}</dd>
              </div>
              <div>
                <dt>Included</dt>
                <dd>{evidence.result.includedAt}</dd>
              </div>
              <div>
                <dt>Gas used</dt>
                <dd>{evidence.result.gasUsed}</dd>
              </div>
            </dl>
            <ExternalLink href={explorerTransaction(evidence.result.transactionHash)}>
              Verify the exit transaction
            </ExternalLink>
          </article>
        </section>

        <section className="proof-section">
          <div className="proof-copy">
            <span className="step-label">Public chain proof</span>
            <h2>Do not trust the screen. Check the receipt.</h2>
            <p>
              The explorer independently shows a successful <code>execute</code> transaction at
              block {evidence.result.blockNumber}. The worker also reconciled the expected exit
              event, burned shares, returned assets, consumed mandate, and zero guard balance.
            </p>
            <ExternalLink href={explorerTransaction(evidence.result.transactionHash)}>
              Open full receipt on Blockscout
            </ExternalLink>
          </div>
          <a
            className="proof-image-link"
            href={explorerTransaction(evidence.result.transactionHash)}
            target="_blank"
            rel="noreferrer"
            aria-label="Open the Day 3 transaction on Blockscout"
          >
            <Image
              alt="Blockscout receipt showing the successful Day 3 VETO exit transaction"
              src={transactionProof}
              placeholder="blur"
              sizes="(max-width: 840px) 100vw, 52vw"
            />
          </a>
        </section>

        <footer>
          <div className="brand footer-brand">
            <VetoMark />
            <span>VETO</span>
          </div>
          <p>
            Recorded {new Date(evidence.recordedAt).toISOString().slice(0, 10)} · Controlled Base
            Sepolia fixture · No real asset value
          </p>
        </footer>
      </div>
    </main>
  );
}
