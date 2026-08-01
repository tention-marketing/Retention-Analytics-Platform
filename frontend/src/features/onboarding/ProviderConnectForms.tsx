import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { SecretField } from './SecretField';
import { describeOnboardingFailure, onboardingFailureTitle } from './onboardingErrors';
import { useConnectKlaviyo, useConnectRecharge, useConnectShopify } from './useOnboarding';

// The three credential forms.
//
// EXPLICIT COMPONENTS WITH EXPLICIT FIELDS, one per provider — not one generic
// form driven by a field descriptor list. A generic form would keep the values
// in a keyed bag that something could stringify whole, and would make the
// request body a mapped object rather than three named properties. Three small
// components are more code and fewer ways to serialize a secret by accident.
//
// EVERY FORM CLEARS ITS SECRET WHEN THE REQUEST SETTLES, success or failure.
// After a failure the non-secret Shopify domain stays so the agency does not
// retype it; nothing else survives.
//
// NOTHING HERE LOGS, and nothing here puts a credential into a callback, a ref
// that outlives the submit, or a value passed upward. The only consumer of these
// strings is the api function that sends them.

/** Shown after a successful connect. `queued` is reported honestly. */
function ConnectSuccess({ provider, queued }: { provider: string; queued: boolean }) {
  return (
    <Alert tone="success" title={`${provider} connected`}>
      <p>
        {queued
          ? 'The first data import has been queued and will start shortly.'
          // NOT dressed up as success-with-a-caveat: the credential is saved and
          // the import genuinely has not begun. Saying otherwise would have an
          // agency waiting for data that nothing is fetching.
          : 'The credentials are saved, but the first data import has not started yet. '
            + 'Use Refresh status to check again shortly.'}
      </p>
    </Alert>
  );
}

function FormError({ error, action }: {
  error: unknown;
  action: 'connect-shopify' | 'connect-klaviyo' | 'connect-recharge';
}) {
  const failure = describeOnboardingFailure(error, action);
  // A confirmed 401 is already redirecting to sign-in.
  if (failure.sessionExpired) return null;
  return (
    <Alert tone="error" title={onboardingFailureTitle(action)}>
      <p>{failure.message}</p>
    </Alert>
  );
}

interface FormShellProps {
  legend: string;
  description: string;
  children: React.ReactNode;
  submitLabel: string;
  submittingLabel: string;
  isSubmitting: boolean;
  onSubmit: (event: React.FormEvent) => void;
  onCancel: () => void;
}

function FormShell({
  legend, description, children, submitLabel, submittingLabel, isSubmitting, onSubmit, onCancel,
}: FormShellProps) {
  const legendId = useId();
  return (
    <form onSubmit={onSubmit} noValidate aria-labelledby={legendId} className="mt-3 space-y-3">
      <div>
        <h4 id={legendId} className="text-sm font-semibold">{legend}</h4>
        <p className="mt-1 text-xs text-[var(--color-ink-muted)]">{description}</p>
      </div>
      {children}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={isSubmitting} loadingLabel={submittingLabel}>
          {submitLabel}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel} disabled={isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/**
 * Clear secrets whenever the form goes away for any reason.
 *
 * The unmount cleanup is what covers a logout, a session expiry and an account
 * change: all three unmount this subtree, and the state dies with it. The
 * explicit clears elsewhere are for the cases that do NOT unmount — a settled
 * request, and a cancel that keeps the card mounted.
 */
function useClearOnUnmount(clear: () => void) {
  const ref = useRef(clear);
  ref.current = clear;
  useEffect(() => () => ref.current(), []);
}

// ---------------------------------------------------------------------------
// Shopify
// ---------------------------------------------------------------------------

interface ShopifyFormProps {
  accountId: number;
  /** From the client's agency-assist request, or the connected store. */
  initialDomain: string;
  /** Changes the copy and the button; the endpoint is the same either way. */
  isUpdate: boolean;
  onDone: () => void;
  onCancel: () => void;
}

export function ShopifyConnectForm({
  accountId, initialDomain, isUpdate, onDone, onCancel,
}: ShopifyFormProps) {
  const domainFieldId = useId();
  const [shopDomain, setShopDomain] = useState(initialDomain);
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);

  const connect = useConnectShopify(accountId);

  const clearSecrets = useCallback(() => {
    setClientId('');
    setClientSecret('');
  }, []);
  useClearOnUnmount(() => {
    clearSecrets();
    setShopDomain('');
  });

  // Fires when the request SETTLES, either way. After a success the domain goes
  // too and the form closes; after a failure the domain stays so the agency can
  // correct one field rather than retype three.
  const settled = connect.succeeded !== null || connect.error !== null;
  useEffect(() => {
    if (!settled) return;
    clearSecrets();
    if (connect.succeeded) {
      setShopDomain('');
      onDone();
    }
  }, [settled, connect.succeeded, clearSecrets, onDone]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (connect.isSubmitting) return;

    // Presence only. No minimum length and no domain pattern: the backend
    // normalizes and validates the domain (scheme, userinfo, port and path are
    // all stripped there), and a client-side rule that disagreed would reject
    // input the server would have accepted.
    const domain = shopDomain.trim();
    const id = clientId.trim();
    const secret = clientSecret.trim();
    if (!domain || !id || !secret) {
      setValidationError('Enter the store domain, client ID and client secret.');
      return;
    }
    setValidationError(null);
    connect.submit({ shopDomain: domain, clientId: id, clientSecret: secret });
  };

  return (
    <>
      {connect.error ? (
        <div className="mt-3">
          <FormError error={connect.error} action="connect-shopify" />
        </div>
      ) : null}

      <FormShell
        legend={isUpdate ? 'Update Shopify credentials' : 'Connect Shopify'}
        description={
          isUpdate
            ? 'Submitting verifies the new credentials and replaces the stored ones. '
              + 'This updates the existing connection rather than adding a second.'
            : 'Enter the store’s own custom-app credentials. We verify them with Shopify '
              + 'before saving.'
        }
        submitLabel={isUpdate ? 'Verify and update' : 'Connect Shopify'}
        submittingLabel={isUpdate ? 'Verifying…' : 'Connecting…'}
        isSubmitting={connect.isSubmitting}
        onSubmit={onSubmit}
        onCancel={() => {
          clearSecrets();
          setShopDomain('');
          connect.reset();
          onCancel();
        }}
      >
        <div>
          <label htmlFor={domainFieldId} className="block text-sm font-medium">
            Permanent store domain
          </label>
          <p className="mt-1 text-xs text-[var(--color-ink-muted)]">
            The <code>.myshopify.com</code> address, not a custom domain. Webhooks are routed
            by this, so a custom domain would never match.
          </p>
          <input
            id={domainFieldId}
            type="text"
            value={shopDomain}
            onChange={(event) => setShopDomain(event.target.value)}
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="none"
            disabled={connect.isSubmitting}
            className="mt-1 w-full rounded-md border border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] px-3 py-2 font-mono text-sm
                       disabled:opacity-60"
          />
        </div>

        {/*
          The client ID is not strictly a secret, but it is half of a credential
          pair and it is submitted together with the secret. Treating the whole
          submission as sensitive is one rule instead of two.
        */}
        <SecretField
          label="Client ID"
          value={clientId}
          onChange={setClientId}
          disabled={connect.isSubmitting}
        />
        <SecretField
          label="Client secret"
          value={clientSecret}
          onChange={setClientSecret}
          disabled={connect.isSubmitting}
        />

        {validationError ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">{validationError}</p>
        ) : null}
      </FormShell>
    </>
  );
}

// ---------------------------------------------------------------------------
// Klaviyo and Recharge — one field each
// ---------------------------------------------------------------------------

interface SingleSecretFormProps {
  accountId: number;
  isUpdate: boolean;
  onDone: () => void;
  onCancel: () => void;
}

export function KlaviyoConnectForm({
  accountId, isUpdate, onDone, onCancel,
}: SingleSecretFormProps) {
  const [apiKey, setApiKey] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const connect = useConnectKlaviyo(accountId);

  const clear = useCallback(() => setApiKey(''), []);
  useClearOnUnmount(clear);

  const settled = connect.succeeded !== null || connect.error !== null;
  useEffect(() => {
    if (!settled) return;
    clear();
    if (connect.succeeded) onDone();
  }, [settled, connect.succeeded, clear, onDone]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (connect.isSubmitting) return;
    const key = apiKey.trim();
    // Presence only. Klaviyo key formats are Klaviyo's to change, and a pattern
    // guessed here would reject a valid key the day they add a prefix.
    if (!key) {
      setValidationError('Enter a Klaviyo private API key.');
      return;
    }
    setValidationError(null);
    connect.submit({ apiKey: key });
  };

  return (
    <>
      {connect.error ? (
        <div className="mt-3">
          <FormError error={connect.error} action="connect-klaviyo" />
        </div>
      ) : null}
      <FormShell
        legend={isUpdate ? 'Update Klaviyo credentials' : 'Connect Klaviyo'}
        description={
          isUpdate
            ? 'Submitting verifies the new key and replaces the stored one.'
            : 'A Klaviyo private API key with read access. We verify it before saving.'
        }
        submitLabel={isUpdate ? 'Verify and update' : 'Connect Klaviyo'}
        submittingLabel={isUpdate ? 'Verifying…' : 'Connecting…'}
        isSubmitting={connect.isSubmitting}
        onSubmit={onSubmit}
        onCancel={() => {
          clear();
          connect.reset();
          onCancel();
        }}
      >
        <SecretField
          label="Private API key"
          value={apiKey}
          onChange={setApiKey}
          disabled={connect.isSubmitting}
        />
        {validationError ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">{validationError}</p>
        ) : null}
      </FormShell>
    </>
  );
}

export function RechargeConnectForm({
  accountId, isUpdate, onDone, onCancel,
}: SingleSecretFormProps) {
  const [token, setToken] = useState('');
  const [validationError, setValidationError] = useState<string | null>(null);
  const connect = useConnectRecharge(accountId);

  const clear = useCallback(() => setToken(''), []);
  useClearOnUnmount(clear);

  const settled = connect.succeeded !== null || connect.error !== null;
  useEffect(() => {
    if (!settled) return;
    clear();
    if (connect.succeeded) onDone();
  }, [settled, connect.succeeded, clear, onDone]);

  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (connect.isSubmitting) return;
    const value = token.trim();
    if (!value) {
      setValidationError('Enter a Recharge Admin API token.');
      return;
    }
    setValidationError(null);
    connect.submit({ token: value });
  };

  return (
    <>
      {connect.error ? (
        <div className="mt-3">
          <FormError error={connect.error} action="connect-recharge" />
        </div>
      ) : null}
      <FormShell
        legend={isUpdate ? 'Update Recharge credentials' : 'Connect Recharge'}
        description={
          isUpdate
            ? 'Submitting verifies the new token and replaces the stored one.'
            : 'A Recharge Admin API token. We verify it before saving.'
        }
        submitLabel={isUpdate ? 'Verify and update' : 'Connect Recharge'}
        submittingLabel={isUpdate ? 'Verifying…' : 'Connecting…'}
        isSubmitting={connect.isSubmitting}
        onSubmit={onSubmit}
        onCancel={() => {
          clear();
          connect.reset();
          onCancel();
        }}
      >
        <SecretField
          label="Admin API token"
          value={token}
          onChange={setToken}
          disabled={connect.isSubmitting}
        />
        {validationError ? (
          <p role="alert" className="text-sm text-[var(--color-danger)]">{validationError}</p>
        ) : null}
      </FormShell>
    </>
  );
}

export { ConnectSuccess };
