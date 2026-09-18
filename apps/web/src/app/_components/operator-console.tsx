'use client';

import Image from 'next/image';
import type { ReactNode } from 'react';
import { useEffect, useState } from 'react';

import { useVetoWallet, type RuleDraft, type VetoWallet } from './use-veto-wallet';
import type { dayThreeEvidence } from '@/data/day-three';

type Evidence = typeof dayThreeEvidence;
type View = 'overview' | 'rules' | 'activity' | 'evidence';

const navigation: ReadonlyArray<{ view: View; label: string; icon: string }> = [
  { view: 'overview', label: 'Overview', icon: 'grid' },
  { view: 'rules', label: 'Exit rules', icon: 'route' },
  { view: 'activity', label: 'Activity', icon: 'pulse' },
  { view: 'evidence', label: 'Evidence', icon: 'proof' },
];

function explorerTransaction(hash: string): string {
  return `https://base-sepolia.blockscout.com/tx/${hash}`;
}

function explorerAddress(address: string): string {
  return `https://base-sepolia.blockscout.com/address/${address}`;
}

function shorten(value: string, start = 6, end = 4): string {
  return `${value.slice(0, start)}…${value.slice(-end)}`;
}

function Icon({ name }: { name: string }) {
  const paths: Record<string, ReactNode> = {
    grid: <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z" />,
    route: <path d="M5 5h6v6H5zM13 13h6v6h-6zM8 11v2a3 3 0 0 0 3 3h2M11 8h5a3 3 0 0 1 3 3v2" />,
    pulse: <path d="M3 12h4l2-6 4 12 2-6h6" />,
    proof: <path d="M6 3h9l3 3v15H6zM14 3v4h4M9 12h6M9 16h6" />,
    arrow: <path d="m9 18 6-6-6-6" />,
    external: <path d="M14 4h6v6M20 4l-9 9M18 13v6H5V6h6" />,
    wallet: <path d="M4 7h15v12H4zM4 7l2-3h11l2 3M15 12h6v4h-6z" />,
    check: <path d="m5 12 4 4L19 6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    clock: (
      <>
        <circle cx="12" cy="12" r="8" />
        <path d="M12 8v5l3 2" />
      </>
    ),
  };

  return (
    <svg aria-hidden="true" className="icon" viewBox="0 0 24 24">
      {paths[name]}
    </svg>
  );
}

function Brand({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'brand brand-compact' : 'brand'}>
      <Image alt="" height={42} priority src="/brand/veto-mark.png" width={42} />
      <div>
        <strong>VETO</strong>
        {compact ? null : <span>Depositor exit control</span>}
      </div>
    </div>
  );
}

function ExternalLink({ href, children }: Readonly<{ href: string; children: ReactNode }>) {
  return (
    <a className="text-link" href={href} rel="noreferrer" target="_blank">
      {children}
      <Icon name="external" />
    </a>
  );
}

function StatusChip({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) {
  return <span className={`status-chip status-${tone}`}>{children}</span>;
}

function LiveOwnerSurface({
  wallet,
  openNewRule,
}: {
  wallet: VetoWallet;
  openNewRule: () => void;
}) {
  const shares = BigInt(wallet.position?.position.shares ?? '0');
  const ownerConnected = Boolean(wallet.address);
  const positionReady = Boolean(
    wallet.address &&
    wallet.runtime?.monitoringReady &&
    wallet.position?.position.supported &&
    shares > 0n,
  );
  const ruleActive = wallet.rules.some((rule) => rule.state === 'ACTIVE');
  return (
    <article className="live-owner-surface">
      <div className="live-owner-copy">
        <div className="live-owner-heading">
          <span className={wallet.runtime?.monitoringReady ? 'readiness ready' : 'readiness'}>
            <span /> {wallet.runtime?.monitoringReady ? 'Monitoring ready' : 'Checking runtime'}
          </span>
          {wallet.runtime ? <small>Block {wallet.runtime.latestBlock}</small> : null}
        </div>
        <h2>{wallet.address ? 'Your live exit-rule workspace' : 'Set a live exit rule.'}</h2>
        {wallet.address && wallet.position ? (
          <p>
            <strong>
              {wallet.position.position.sharesFormatted} {wallet.position.position.symbol}
            </strong>{' '}
            shares found in the configured supported vault at block{' '}
            {wallet.position.observedAtBlock}.
          </p>
        ) : (
          <p>
            Connect the owner wallet to discover its supported vault shares and configure the first
            implemented rule type: a management-fee ceiling. VETO never receives the private key.
          </p>
        )}
      </div>
      <div className="live-owner-actions">
        {wallet.address ? (
          <button
            className="button button-primary"
            disabled={!wallet.runtime?.monitoringReady || shares <= 0n}
            onClick={openNewRule}
            type="button"
          >
            {shares > 0n ? 'Set exit rule' : 'No supported shares'} <Icon name="arrow" />
          </button>
        ) : (
          <button className="button button-primary" onClick={wallet.connect} type="button">
            <Icon name="wallet" /> Connect owner wallet
          </button>
        )}
        {wallet.position ? (
          <ExternalLink href={explorerAddress(wallet.position.position.vault)}>
            Inspect vault
          </ExternalLink>
        ) : null}
        {wallet.address ? (
          <button
            className="button button-secondary"
            disabled={wallet.loading}
            onClick={() => void wallet.refresh()}
            type="button"
          >
            {wallet.loading ? 'Refreshing…' : 'Refresh live state'}
          </button>
        ) : null}
      </div>
      <ol aria-label="Live exit rule setup" className="owner-flow">
        <li className={ownerConnected ? 'done' : 'current'}>
          <span>1</span>
          <div>
            <strong>Connect owner</strong>
            <small>{ownerConnected ? 'Wallet connected' : 'Owner signature authority'}</small>
          </div>
        </li>
        <li className={positionReady ? 'done' : ownerConnected ? 'current' : ''}>
          <span>2</span>
          <div>
            <strong>Verify position</strong>
            <small>{positionReady ? 'Vault and monitor ready' : 'Supported shares required'}</small>
          </div>
        </li>
        <li className={ruleActive ? 'done' : positionReady ? 'current' : ''}>
          <span>3</span>
          <div>
            <strong>Approve and arm</strong>
            <small>{ruleActive ? 'Rule is monitored' : 'Two owner transactions'}</small>
          </div>
        </li>
      </ol>
    </article>
  );
}

function Overview({
  evidence,
  openRule,
  openNewRule,
  wallet,
}: {
  evidence: Evidence;
  openRule: () => void;
  openNewRule: () => void;
  wallet: VetoWallet;
}) {
  const recent = evidence.activity.slice(-3).reverse();

  return (
    <div className="view-enter">
      <section className="page-intro">
        <div>
          <span className="overline">Depositor-controlled exits</span>
          <h1>Your right to leave before the rules change.</h1>
          <p>
            Define when your approved position may remain in a managed vault. KeeperHub submits an
            eligible exit; the guard independently rechecks your rule onchain before funds move.
          </p>
        </div>
        <StatusChip>Execution-time enforced</StatusChip>
      </section>

      <div className="fixture-notice">
        <span>Real Morpho V2 public proof</span>
        <p>
          Canonical Morpho Vault V2 code on Base Sepolia · valueless test asset · not a mainnet
          withdrawal
        </p>
      </div>

      <LiveOwnerSurface openNewRule={openNewRule} wallet={wallet} />

      <section className="command-grid">
        <article className="result-hero">
          <Image
            alt=""
            className="result-art"
            height={1024}
            priority
            src="/brand/veto-exit-path.png"
            width={1536}
          />
          <div className="result-hero-top">
            <span className="panel-label">Recorded return to owner</span>
            <span className="result-seal">
              <Image
                alt="Completed bounded exit"
                height={31}
                src="/brand/veto-exit-emblem.png"
                width={31}
              />
            </span>
          </div>
          <div className="asset-total">
            <strong>{evidence.result.assetsReturned}</strong>
            <span>{evidence.position.assetName}</span>
          </div>
          <div className="result-context">
            <div>
              <span>Exit headroom</span>
              <strong>{evidence.proposal.leadTime}</strong>
              <small>before fee eligibility</small>
            </div>
            <div>
              <span>Owner shares</span>
              <strong>{evidence.position.sharesAfter}</strong>
              <small>after redemption</small>
            </div>
            <div>
              <span>Guard balance</span>
              <strong>{evidence.result.guardAssets}</strong>
              <small>nothing retained</small>
            </div>
          </div>
          <ExternalLink href={explorerTransaction(evidence.result.transactionHash)}>
            Verify transaction
          </ExternalLink>
        </article>

        <article className="surface rule-summary">
          <div className="surface-heading">
            <div>
              <span className="panel-label">Implemented rule type</span>
              <h2>Management fee ceiling</h2>
            </div>
            <StatusChip>Consumed</StatusChip>
          </div>
          <div className="threshold-visual" aria-label="One percent limit and two percent proposal">
            <div className="threshold-numbers">
              <span>
                Owner limit <strong>{evidence.instruction.feeCeiling}</strong>
              </span>
              <span>
                Proposed <strong>{evidence.proposal.proposedFee}</strong>
              </span>
            </div>
            <div className="threshold-track">
              <span className="limit-marker" />
              <span className="proposal-marker" />
            </div>
            <div className="threshold-scale">
              <span>0%</span>
              <span>1%</span>
              <span>2%</span>
              <span>3%</span>
            </div>
          </div>
          <p className="rule-copy">
            The queued proposal crossed this owner&apos;s chosen ceiling. That is a policy
            breach—not a claim of curator malice or imminent loss. The mandate authorized exactly{' '}
            {evidence.instruction.shares} shares and fixed the receiver to the owner.
          </p>
          <button className="button button-secondary" onClick={openRule} type="button">
            Review rule <Icon name="arrow" />
          </button>
        </article>
      </section>

      <section className="lower-grid">
        <article className="surface position-surface">
          <div className="surface-heading">
            <div>
              <span className="panel-label">Monitored position</span>
              <h2>{evidence.position.assetName} Vault</h2>
            </div>
            <StatusChip tone="base">Base Sepolia</StatusChip>
          </div>
          <div className="position-row">
            <div className="asset-glyph">VU</div>
            <div className="position-main">
              <strong>{evidence.position.assetName}</strong>
              <ExternalLink href={explorerAddress(evidence.position.vault)}>
                {shorten(evidence.position.vault, 10, 8)}
              </ExternalLink>
            </div>
            <div className="position-stat">
              <span>Before exit</span>
              <strong>{evidence.position.sharesBefore}</strong>
            </div>
            <div className="position-stat">
              <span>After exit</span>
              <strong>{evidence.position.sharesAfter}</strong>
            </div>
          </div>
        </article>

        <article className="surface activity-preview">
          <div className="surface-heading">
            <div>
              <span className="panel-label">Latest activity</span>
              <h2>Execution trail</h2>
            </div>
          </div>
          <ol className="mini-timeline">
            {recent.map((event) => (
              <li key={event.transactionHash}>
                <span className={`event-dot event-${event.kind}`} />
                <div>
                  <strong>{event.label}</strong>
                  <small>Block {event.blockNumber}</small>
                </div>
                <ExternalLink href={explorerTransaction(event.transactionHash)}>View</ExternalLink>
              </li>
            ))}
          </ol>
        </article>
      </section>
      <aside className="liquidity-note">
        <strong>Authorization is not a liquidity guarantee.</strong>
        <p>
          VETO can enforce when an exit is allowed. If the exact redemption cannot execute, the
          transaction reverts and preserves the position; P0 does not attempt a partial exit.
        </p>
      </aside>
    </div>
  );
}

function Rules({
  evidence,
  openRule,
  openNewRule,
  wallet,
}: {
  evidence: Evidence;
  openRule: () => void;
  openNewRule: () => void;
  wallet: VetoWallet;
}) {
  const liveRule = wallet.rules.find((rule) => rule.state === 'ACTIVE');
  return (
    <div className="view-enter">
      <section className="page-intro page-intro-action">
        <div>
          <span className="overline">Owner mandates</span>
          <h1>Exit rules</h1>
          <p>
            {wallet.runtime?.guardVersion === 'v2'
              ? 'One mandate, five optional depositor policy boundaries. Pre-authorized conditional exits for queued Morpho Vault V2 governance changes.'
              : 'Owner-defined conditions for continued participation. Implemented rule type: queued management-fee ceiling (V1).'}
          </p>
        </div>
        <button className="button button-primary" onClick={openNewRule} type="button">
          <Icon name="plus" /> New exit rule
        </button>
      </section>
      <article className="surface live-rule-record">
        <div className="surface-heading">
          <div>
            <span className="panel-label">Connected owner</span>
            <h2>{liveRule ? `Active mandate ${liveRule.mandate_id}` : 'No active live mandate'}</h2>
          </div>
          <StatusChip tone={liveRule ? 'verified' : 'neutral'}>
            {liveRule ? (liveRule.execution_state ?? 'Monitoring') : 'Not armed'}
          </StatusChip>
        </div>
        {wallet.address ? (
          <div className="live-rule-body">
            <p>
              {liveRule
                ? `The database and chain agree on an owner-bound rule for ${shorten(liveRule.vault_address, 10, 8)}.`
                : 'The connected address has no rule registered with this VETO runtime.'}
            </p>
            {liveRule && (
              <div style={{ margin: '0.75rem 0', fontSize: '0.875rem' }}>
                {liveRule.guard_version === 'v2' ? (
                  <div>
                    <span
                      style={{
                        background: '#2563eb',
                        color: '#fff',
                        padding: '2px 8px',
                        borderRadius: '4px',
                        fontSize: '0.75rem',
                        fontWeight: 600,
                      }}
                    >
                      V2 Multi-Policy
                    </span>
                    {liveRule.policy_config_json ? (
                      <div style={{ marginTop: '0.5rem', color: '#94a3b8' }}>
                        {Boolean(
                          BigInt(String(liveRule.policy_config_json.policyFlags ?? '0')) & 1n,
                        ) && <div>✓ Management fee ceiling configured</div>}
                        {Boolean(
                          BigInt(String(liveRule.policy_config_json.policyFlags ?? '0')) & 2n,
                        ) && <div>✓ Performance fee ceiling configured</div>}
                        {Boolean(
                          BigInt(String(liveRule.policy_config_json.policyFlags ?? '0')) & 4n,
                        ) && <div>✓ Relative cap ceilings configured</div>}
                        {Boolean(
                          BigInt(String(liveRule.policy_config_json.policyFlags ?? '0')) & 8n,
                        ) && <div>✓ Adapter allowlist configured</div>}
                        {Boolean(
                          BigInt(String(liveRule.policy_config_json.policyFlags ?? '0')) & 16n,
                        ) && <div>✓ Redemption gate allowlists configured</div>}
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <span
                    style={{
                      background: '#475569',
                      color: '#fff',
                      padding: '2px 8px',
                      borderRadius: '4px',
                      fontSize: '0.75rem',
                    }}
                  >
                    V1 Management Fee Ceiling
                  </span>
                )}
              </div>
            )}
            {liveRule ? (
              <button
                className="button button-danger"
                disabled={wallet.action.stage === 'cancelling'}
                onClick={() => void wallet.cancelRule(liveRule.mandate_id)}
                type="button"
              >
                Cancel rule in owner wallet
              </button>
            ) : (
              <button className="button button-secondary" onClick={openNewRule} type="button">
                Prepare owner rule
              </button>
            )}
          </div>
        ) : (
          <div className="live-rule-body">
            <p>Connect the owner wallet to load live rules and cancellation authority.</p>
            <button className="button button-secondary" onClick={wallet.connect} type="button">
              Connect wallet
            </button>
          </div>
        )}
        {wallet.action.stage !== 'idle' ? (
          <div className={`action-message action-${wallet.action.stage}`} aria-live="polite">
            {wallet.action.message}
          </div>
        ) : null}
      </article>
      <div className="recorded-divider">
        <span>Recorded public evidence</span>
      </div>
      <article className="surface rule-record">
        <div className="rule-record-top">
          <div className="rule-identity">
            <span className="rule-index">01</span>
            <div>
              <span className="panel-label">Implemented rule · management fee ceiling</span>
              <h2>Exit above {evidence.instruction.feeCeiling}</h2>
            </div>
          </div>
          <StatusChip>Consumed by exit</StatusChip>
        </div>
        <div className="rule-fields">
          <div>
            <span>Vault</span>
            <strong>{shorten(evidence.position.vault, 10, 8)}</strong>
          </div>
          <div>
            <span>Shares authorized</span>
            <strong>{evidence.instruction.shares}</strong>
          </div>
          <div>
            <span>Minimum return</span>
            <strong>{evidence.instruction.minimumReturn}</strong>
          </div>
          <div>
            <span>Safety window</span>
            <strong>{evidence.instruction.safetyWindow}</strong>
          </div>
          <div>
            <span>Expiry</span>
            <strong>{evidence.instruction.expiresAt}</strong>
          </div>
        </div>
        <div className="rule-actions">
          <button className="button button-secondary" onClick={openRule} type="button">
            Full rule details
          </button>
          <ExternalLink href={explorerTransaction(evidence.proposal.transactionHash)}>
            Source proposal
          </ExternalLink>
        </div>
      </article>
      <aside className="empty-guidance">
        <div className="guidance-icon">
          <Icon name="route" />
        </div>
        <div>
          <strong>Rules are owner-bound</strong>
          <p>
            KeeperHub submits an eligible call, but the guard decides whether it can succeed at
            execution time. It fixes the receiver, shares, fee ceiling, minimum return, expiry, and
            cancellation authority. VETO exits the owner; it does not cancel Morpho governance.
          </p>
        </div>
      </aside>
    </div>
  );
}

function Activity({ evidence }: { evidence: Evidence }) {
  return (
    <div className="view-enter">
      <section className="page-intro">
        <div>
          <span className="overline">Recorded on-chain history</span>
          <h1>Activity</h1>
          <p>
            {evidence.activity.length} KeeperHub-submitted transactions from canonical deployment
            through the verified exit.
          </p>
        </div>
        <StatusChip tone="verified">{evidence.activity.length} confirmed</StatusChip>
      </section>
      <article className="surface activity-log">
        {evidence.activity
          .slice()
          .reverse()
          .map((event, index) => (
            <a
              className="activity-row"
              href={explorerTransaction(event.transactionHash)}
              key={event.transactionHash}
              rel="noreferrer"
              target="_blank"
            >
              <div className={`activity-icon event-${event.kind}`}>
                <Icon
                  name={
                    event.kind === 'result' ? 'check' : event.kind === 'trigger' ? 'pulse' : 'clock'
                  }
                />
              </div>
              <div className="activity-copy">
                <strong>{event.label}</strong>
                <span>{shorten(event.transactionHash, 12, 8)}</span>
              </div>
              <div className="activity-meta">
                <span>Block {event.blockNumber}</span>
                <small>{event.gasUsed} gas</small>
              </div>
              <Icon name="external" />
              {index === 0 ? <span className="latest-marker">Latest</span> : null}
            </a>
          ))}
      </article>
    </div>
  );
}

function EvidenceView({ evidence }: { evidence: Evidence }) {
  return (
    <div className="view-enter">
      <section className="page-intro">
        <div>
          <span className="overline">Public verification</span>
          <h1>Evidence</h1>
          <p>Use the chain receipt—not this interface—as the final source of truth.</p>
        </div>
        <StatusChip tone="verified">Two public outcomes</StatusChip>
      </section>
      <section className="evidence-grid">
        <article className="surface evidence-facts">
          <span className="panel-label">Production compatibility</span>
          <h2>Gauntlet USDC Prime</h2>
          <p>
            VETO operates against real Morpho Vault V2 architecture. Public testnet execution runs
            on Base Sepolia with valueless test tokens, while read and simulation proofs directly
            target the live Gauntlet vault on Base Mainnet.
          </p>
          <dl>
            <div>
              <dt>LIVE MAINNET READ</dt>
              <dd>Read-only state verification (0x050c…56f0, timelock 3.0d)</dd>
            </div>
            <div>
              <dt>PINNED FORK</dt>
              <dd>Simulation of real depositor exit ($3.07M USDC)</dd>
            </div>
            <div>
              <dt>PUBLIC TESTNET EXECUTION</dt>
              <dd>Live KeeperHub transaction with test token</dd>
            </div>
            <div>
              <dt>Fund Safety</dt>
              <dd>VETO does not hold or move mainnet depositor funds without authorization</dd>
            </div>
          </dl>
          <ExternalLink href="https://basescan.org/address/0x050cE30b927Da55177A4914EC73480238BAD56f0">
            Open Gauntlet USDC Prime on Basescan
          </ExternalLink>
        </article>
        <article className="surface evidence-facts">
          <span className="panel-label">Contract provenance</span>
          <h2>Canonical Morpho runtime</h2>
          <p>
            Unmodified Morpho Vault V2 release {evidence.source.release}, pinned to commit{' '}
            {shorten(evidence.source.commit, 12, 8)}. The factory runtime hash exactly matches
            Morpho&apos;s canonical Base deployment.
          </p>
          <dl>
            <div>
              <dt>Factory</dt>
              <dd>{shorten(evidence.position.factory, 12, 8)}</dd>
            </div>
            <div>
              <dt>Vault</dt>
              <dd>{shorten(evidence.position.vault, 12, 8)}</dd>
            </div>
            <div>
              <dt>Factory recognition</dt>
              <dd>isVaultV2 = true</dd>
            </div>
          </dl>
          <ExternalLink href={explorerAddress(evidence.position.vault)}>
            Open Morpho V2 vault
          </ExternalLink>
        </article>
        <article className="surface evidence-facts">
          <span className="panel-label">Exit receipt (Day 8 conditional)</span>
          <h2>KeeperHub conditional execution</h2>
          <dl>
            <div>
              <dt>Status</dt>
              <dd>Success ({evidence.result.state})</dd>
            </div>
            <div>
              <dt>KeeperHub ID</dt>
              <dd>{evidence.result.executionId}</dd>
            </div>
            <div>
              <dt>Block</dt>
              <dd>{evidence.result.blockNumber}</dd>
            </div>
            <div>
              <dt>Returned assets</dt>
              <dd>
                {evidence.result.assetsReturned} {evidence.position.assetName}
              </dd>
            </div>
            <div>
              <dt>Mandate consumed</dt>
              <dd>Yes (single-use enforced)</dd>
            </div>
            <div>
              <dt>Historical direct proof</dt>
              <dd>{evidence.result.historicalDirectExecutionId}</dd>
            </div>
          </dl>
          <ExternalLink href={explorerTransaction(evidence.result.transactionHash)}>
            Open Blockscout receipt
          </ExternalLink>
        </article>
        <article className="surface evidence-facts">
          <span className="panel-label">Conditional false (Day 8 safe block)</span>
          <h2>Revocation held without broadcast</h2>
          <p>
            The 2% proposal was revoked onchain by the curator. KeeperHub read executableAt = 0,
            evaluated condition false, and safely withheld execution with zero financial broadcast.
          </p>
          <dl>
            <div>
              <dt>KeeperHub action</dt>
              <dd>Execution withheld (executed: false)</dd>
            </div>
            <div>
              <dt>Financial broadcast</dt>
              <dd>None (0 financial transactions)</dd>
            </div>
            <div>
              <dt>Owner shares</dt>
              <dd>{evidence.revokedProposal.ownerShares} unchanged</dd>
            </div>
            <div>
              <dt>Guard balance</dt>
              <dd>{evidence.revokedProposal.guardAssets}</dd>
            </div>
            <div>
              <dt>Mandate</dt>
              <dd>{evidence.revokedProposal.mandateStillActive ? 'Still active' : 'Consumed'}</dd>
            </div>
            <div>
              <dt>Worker state</dt>
              <dd>{evidence.revokedProposal.workerState}</dd>
            </div>
          </dl>
          <ExternalLink href={explorerTransaction(evidence.revokedProposal.curatorRevocationTx)}>
            Open curator revocation tx
          </ExternalLink>
        </article>
      </section>
      <div className="truth-statement">
        <strong>Execution-time enforcement</strong>
        <p>
          One public run exits while the rule remains true. The second preserves every share when
          the proposal is revoked. Together they show that execution depends on current Morpho
          state, not a stale alert. The asset remains a valueless test token.
        </p>
      </div>
    </div>
  );
}

function RuleDrawer({
  evidence,
  mode,
  close,
  wallet,
}: {
  evidence: Evidence;
  mode: 'review' | 'new';
  close: () => void;
  wallet: VetoWallet;
}) {
  const isNew = mode === 'new';
  const armTransaction = evidence.activity.find((entry) => entry.label === 'Exit rule armed');
  const [draft, setDraft] = useState<RuleDraft>({
    feePercent: '1.00',
    shares: wallet.position?.position.sharesFormatted ?? evidence.instruction.shares,
    minimumReturn: wallet.position?.position.assetsFormatted ?? evidence.instruction.minimumReturn,
    expiresHours: '24',
    safetyMinutes: '5',
    managementFeeEnabled: true,
    performanceFeeEnabled: false,
    performanceFeePercent: '',
    relativeCapEnabled: false,
    relativeCaps: [],
    adapterAllowlistEnabled: false,
    approvedAdapters: [],
    redemptionGateAllowlistEnabled: false,
    approvedSendSharesGates: [],
    approvedReceiveAssetsGates: [],
  });
  const [relativeCapRows, setRelativeCapRows] = useState<
    Array<{ riskId: string; maxRelativeCapPercent: string }>
  >([]);
  const [adapterInput, setAdapterInput] = useState('');
  const [sendGateInput, setSendGateInput] = useState('');
  const [receiveGateInput, setReceiveGateInput] = useState('');
  const working = ['approving', 'arming', 'registering'].includes(wallet.action.stage);

  function updateDraft(field: keyof RuleDraft, value: string) {
    setDraft((current) => ({ ...current, [field]: value }));
  }

  return (
    <div
      className="drawer-backdrop"
      onMouseDown={(event) => event.target === event.currentTarget && close()}
      role="presentation"
    >
      <section
        aria-labelledby="drawer-title"
        aria-modal="true"
        className="rule-drawer"
        role="dialog"
      >
        <header>
          <div>
            <span className="overline">{isNew ? 'Prepare mandate' : 'Mandate 0'}</span>
            <h2 id="drawer-title">{isNew ? 'New exit rule' : 'Recorded exit rule'}</h2>
          </div>
          <button
            aria-label="Close rule details"
            autoFocus
            className="icon-button"
            onClick={close}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>
        <p className="drawer-note">
          {isNew
            ? wallet.runtime?.guardVersion === 'v2'
              ? 'One mandate, five optional depositor policy boundaries. VETO requests two owner transactions: one finite share approval and one bounded mandate. The server verifies the receipt and onchain mappings before monitoring.'
              : 'This creates a management-fee ceiling exit rule (V1). VETO requests two owner transactions: one finite share approval and one bounded mandate. The server verifies the receipt before monitoring it.'
            : 'This mandate is already consumed. Values below are read-only and come from the canonical Day 8 real-Morpho run.'}
        </p>
        {isNew && wallet.position?.mandate?.active ? (
          <div
            style={{
              margin: '0 0 1rem',
              padding: '0.75rem',
              background: 'rgba(255, 180, 0, 0.1)',
              border: '1px solid rgba(255, 180, 0, 0.3)',
              borderRadius: '6px',
              color: '#fcd34d',
              fontSize: '0.85rem',
            }}
          >
            <strong style={{ display: 'block', marginBottom: '0.25rem', color: '#fbbf24' }}>
              Active Mandate Detected (Migration Notice)
            </strong>
            <span>
              An active mandate is already registered for this position. Arming a new mandate
              replaces authorization in the guard, but please ensure previous allowances are managed
              so two guards do not simultaneously authorize exits on the same shares.
            </span>
          </div>
        ) : null}
        <form className="rule-form" onSubmit={(event) => event.preventDefault()}>
          <label>
            Rule type
            <input
              value={
                wallet.runtime?.guardVersion === 'v2'
                  ? 'Morpho Vault V2 Multi-Policy Boundaries'
                  : 'Queued management fee above ceiling'
              }
              readOnly
            />
          </label>
          <label>
            Vault address
            <input value={wallet.position?.position.vault ?? evidence.position.vault} readOnly />
          </label>
          <div className="form-grid">
            <label>
              Management fee ceiling (%)
              <input
                onChange={(event) => updateDraft('feePercent', event.target.value)}
                inputMode="decimal"
                readOnly={!isNew}
                value={isNew ? draft.feePercent : evidence.instruction.feeCeiling.replace('%', '')}
              />
            </label>
            <label>
              Shares to exit
              <input
                onChange={(event) => updateDraft('shares', event.target.value)}
                inputMode="decimal"
                readOnly={!isNew}
                value={isNew ? draft.shares : evidence.instruction.shares}
              />
            </label>
          </div>

          <details className="policy-accordion" open={false}>
            <summary>
              <strong>Additional Vault Policies (V2)</strong>
              <small>
                Configure ceilings for performance fees, relative caps, adapters, and gates
              </small>
            </summary>

            <div className="policy-section">
              <label>
                <strong>Performance fee ceiling (%)</strong>
                <input
                  inputMode="decimal"
                  placeholder="e.g. 15.0"
                  readOnly={!isNew}
                  value={draft.performanceFeePercent ?? ''}
                  onChange={(e) => {
                    updateDraft('performanceFeePercent', e.target.value);
                    if (e.target.value)
                      setDraft((cur) => ({ ...cur, performanceFeeEnabled: true }));
                  }}
                />
                <small>Fee charged on yield/performance, capped by protocol at 50%.</small>
              </label>
            </div>

            <div className="policy-section">
              <label>
                <strong>Relative cap ceilings (risk ID & max %)</strong>
                <small style={{ display: 'block', marginBottom: '0.5rem' }}>
                  Limits what the vault may permit for configured risk IDs; it does not claim
                  current allocation equals the cap.
                </small>
              </label>
              {relativeCapRows.map((row, idx) => (
                <div
                  key={idx}
                  style={{
                    display: 'flex',
                    gap: '0.5rem',
                    marginBottom: '0.5rem',
                    alignItems: 'center',
                  }}
                >
                  <input
                    placeholder="Risk ID (0x... 32 bytes)"
                    value={row.riskId}
                    readOnly={!isNew}
                    onChange={(e) => {
                      const updated = [...relativeCapRows];
                      updated[idx] = { ...updated[idx], riskId: e.target.value };
                      setRelativeCapRows(updated);
                      setDraft((cur) => ({
                        ...cur,
                        relativeCaps: updated,
                        relativeCapEnabled: true,
                      }));
                    }}
                    style={{ flex: 2, fontFamily: 'monospace', fontSize: '0.8rem' }}
                  />
                  <input
                    placeholder="Max % (0-100)"
                    value={row.maxRelativeCapPercent}
                    readOnly={!isNew}
                    onChange={(e) => {
                      const updated = [...relativeCapRows];
                      updated[idx] = { ...updated[idx], maxRelativeCapPercent: e.target.value };
                      setRelativeCapRows(updated);
                      setDraft((cur) => ({
                        ...cur,
                        relativeCaps: updated,
                        relativeCapEnabled: true,
                      }));
                    }}
                    style={{ flex: 1 }}
                  />
                  {isNew && (
                    <button
                      type="button"
                      className="button button-secondary"
                      style={{ padding: '0.25rem 0.5rem' }}
                      onClick={() => {
                        const updated = relativeCapRows.filter((_, i) => i !== idx);
                        setRelativeCapRows(updated);
                        setDraft((cur) => ({
                          ...cur,
                          relativeCaps: updated,
                          relativeCapEnabled: updated.length > 0,
                        }));
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
              {isNew && (
                <button
                  type="button"
                  className="button button-secondary"
                  style={{ marginTop: '0.25rem', fontSize: '0.85rem' }}
                  onClick={() => {
                    const updated = [...relativeCapRows, { riskId: '', maxRelativeCapPercent: '' }];
                    setRelativeCapRows(updated);
                    setDraft((cur) => ({
                      ...cur,
                      relativeCaps: updated,
                      relativeCapEnabled: true,
                    }));
                  }}
                >
                  + Add Risk Cap Row
                </button>
              )}
            </div>

            <div className="policy-section">
              <label>
                <strong>Approved adapters (allowlist)</strong>
                <input
                  placeholder="e.g. 0x1111... (comma-separated)"
                  readOnly={!isNew}
                  value={adapterInput}
                  onChange={(e) => {
                    setAdapterInput(e.target.value);
                    const parsed = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    setDraft((cur) => ({
                      ...cur,
                      approvedAdapters: parsed,
                      adapterAllowlistEnabled: true,
                    }));
                  }}
                />
                <small>
                  An added adapter becomes available to allocators; it does not mean capital has
                  already moved. An empty allowlist strictly forbids any newly added adapters.
                </small>
              </label>
            </div>

            <div className="policy-section">
              <label>
                <strong>Redemption gate allowlists</strong>
              </label>
              <label style={{ marginTop: '0.5rem' }}>
                Approved send-shares gates
                <input
                  placeholder="e.g. 0x3333... (comma-separated)"
                  readOnly={!isNew}
                  value={sendGateInput}
                  onChange={(e) => {
                    setSendGateInput(e.target.value);
                    const parsed = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    setDraft((cur) => ({
                      ...cur,
                      approvedSendSharesGates: parsed,
                      redemptionGateAllowlistEnabled: true,
                    }));
                  }}
                />
                <small>
                  Authorized contracts to gate share redemptions. address(0) is implicitly accepted.
                </small>
              </label>
              <label style={{ marginTop: '0.5rem' }}>
                Approved receive-assets gates
                <input
                  placeholder="e.g. 0x4444... (comma-separated)"
                  readOnly={!isNew}
                  value={receiveGateInput}
                  onChange={(e) => {
                    setReceiveGateInput(e.target.value);
                    const parsed = e.target.value
                      .split(',')
                      .map((s) => s.trim())
                      .filter(Boolean);
                    setDraft((cur) => ({
                      ...cur,
                      approvedReceiveAssetsGates: parsed,
                      redemptionGateAllowlistEnabled: true,
                    }));
                  }}
                />
                <small>
                  Authorized contracts to gate asset transfers. address(0) is implicitly accepted.
                </small>
              </label>
            </div>
          </details>
          <div className="form-grid">
            <label>
              Minimum return
              <input
                onChange={(event) => updateDraft('minimumReturn', event.target.value)}
                inputMode="decimal"
                readOnly={!isNew}
                value={isNew ? draft.minimumReturn : evidence.instruction.minimumReturn}
              />
            </label>
            <label>
              Safety window
              <input
                onChange={(event) => updateDraft('safetyMinutes', event.target.value)}
                inputMode="decimal"
                readOnly={!isNew}
                value={isNew ? draft.safetyMinutes : evidence.instruction.safetyWindow}
              />
            </label>
          </div>
          {isNew ? (
            <label>
              Rule expires after (hours)
              <input
                inputMode="numeric"
                onChange={(event) => updateDraft('expiresHours', event.target.value)}
                value={draft.expiresHours}
              />
            </label>
          ) : null}
          <label>
            Receiver
            <input value={wallet.address ?? evidence.position.owner} readOnly />
            <small>Always fixed to the mandate owner.</small>
          </label>
          <div className="approval-line">
            <Icon name="wallet" />
            <div>
              <strong>Two owner signatures</strong>
              <span>Exact share approval, then arm the guard.</span>
            </div>
          </div>
          <div className="liquidity-warning">
            <strong>Liquidity boundary</strong>
            <span>
              This rule authorizes an exact redemption; it cannot guarantee executable vault
              liquidity and will not automatically submit a partial exit.
            </span>
          </div>
          {isNew && wallet.action.stage !== 'idle' ? (
            <div className={`action-message action-${wallet.action.stage}`} aria-live="polite">
              {wallet.action.message}
              {'transactionHash' in wallet.action && wallet.action.transactionHash ? (
                <ExternalLink href={explorerTransaction(wallet.action.transactionHash)}>
                  View transaction
                </ExternalLink>
              ) : null}
            </div>
          ) : null}
          {isNew ? (
            wallet.address ? (
              <button
                className="button button-primary button-block"
                disabled={
                  working ||
                  !wallet.runtime?.monitoringReady ||
                  Number(wallet.position?.position.shares ?? '0') <= 0
                }
                onClick={() => void wallet.approveAndArm(draft)}
                type="button"
              >
                {working
                  ? 'Waiting for owner confirmation…'
                  : wallet.runtime?.monitoringReady
                    ? 'Approve shares and arm rule'
                    : 'Monitoring runtime is unavailable'}
              </button>
            ) : (
              <button
                className="button button-primary button-block"
                onClick={wallet.connect}
                type="button"
              >
                Connect owner wallet to continue
              </button>
            )
          ) : (
            <ExternalLink
              href={explorerTransaction(
                armTransaction?.transactionHash ?? evidence.result.transactionHash,
              )}
            >
              View arming transaction
            </ExternalLink>
          )}
        </form>
      </section>
    </div>
  );
}

export function OperatorConsole({ evidence }: { evidence: Evidence }) {
  const [view, setView] = useState<View>('overview');
  const [drawer, setDrawer] = useState<'review' | 'new'>();
  const wallet = useVetoWallet();

  useEffect(() => {
    if (!drawer) return;
    const handleKey = (event: KeyboardEvent) => event.key === 'Escape' && setDrawer(undefined);
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [drawer]);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <Brand />
        <nav aria-label="Primary navigation">
          {navigation.map((item) => (
            <button
              aria-current={view === item.view ? 'page' : undefined}
              className={view === item.view ? 'nav-item active' : 'nav-item'}
              key={item.view}
              onClick={() => setView(item.view)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className="network-orb" />
          <div>
            <strong>Base Sepolia</strong>
            <span>Controlled environment</span>
          </div>
        </div>
      </aside>

      <section className="app-main">
        <header className="topbar">
          <Brand compact />
          <div className="run-context">
            <span className="live-orb" /> Live control plane{' '}
            <strong>{wallet.runtime?.monitoringReady ? 'READY' : 'CHECKING'}</strong>
          </div>
          <button className="wallet-button" onClick={wallet.connect} type="button">
            <Icon name="wallet" />
            <span aria-live="polite">{wallet.message}</span>
          </button>
        </header>
        <div className="content-frame">
          {view === 'overview' ? (
            <Overview
              evidence={evidence}
              openNewRule={() => {
                wallet.resetAction();
                setDrawer('new');
              }}
              openRule={() => setDrawer('review')}
              wallet={wallet}
            />
          ) : null}
          {view === 'rules' ? (
            <Rules
              evidence={evidence}
              openNewRule={() => {
                wallet.resetAction();
                setDrawer('new');
              }}
              openRule={() => setDrawer('review')}
              wallet={wallet}
            />
          ) : null}
          {view === 'activity' ? <Activity evidence={evidence} /> : null}
          {view === 'evidence' ? <EvidenceView evidence={evidence} /> : null}
        </div>
        <nav aria-label="Mobile navigation" className="mobile-nav">
          {navigation.map((item) => (
            <button
              aria-current={view === item.view ? 'page' : undefined}
              className={view === item.view ? 'active' : ''}
              key={item.view}
              onClick={() => setView(item.view)}
              type="button"
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>
      </section>
      {drawer ? (
        <RuleDrawer
          close={() => setDrawer(undefined)}
          evidence={evidence}
          key={`${drawer}-${wallet.address ?? 'disconnected'}`}
          mode={drawer}
          wallet={wallet}
        />
      ) : null}
    </main>
  );
}
