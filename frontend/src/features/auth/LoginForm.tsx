import { useEffect, useId, useRef, useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { describeLoginFailure } from '@/api/authErrors';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { useLogin } from './useAuth';
import type { AgencyUser } from '@/types/domain';

/**
 * Client-side validation, kept to what a form can honestly know.
 *
 * NOTE THE ABSENT PASSWORD RULE. The backend deliberately does NOT enforce a
 * minimum length at login — it removed that rule because a short-password 400
 * and a wrong-password 401 were two different answers to the same question,
 * which is a credential oracle. Re-adding a length rule here would recreate it
 * client-side and, worse, could reject a valid existing password the backend
 * would have accepted. "Required" is the only thing this form may assert.
 */
const loginSchema = z.object({
  email: z
    .string()
    .trim()
    .min(1, 'Enter your email address.')
    .email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
});

type LoginFormValues = z.infer<typeof loginSchema>;

// Inline icons rather than an icon package: two paths do not justify a
// dependency, a bundle cost, and another supply-chain edge on the sign-in page.
// Both are decorative — the button carries the accessible name — so they are
// hidden from assistive technology entirely.
const ICON_PROPS = {
  viewBox: '0 0 20 20',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  className: 'size-5',
  'aria-hidden': true,
  focusable: 'false',
} as const;

function EyeIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M1.5 10S4.6 4.5 10 4.5 18.5 10 18.5 10 15.4 15.5 10 15.5 1.5 10 1.5 10Z" />
      <circle cx="10" cy="10" r="2.6" />
    </svg>
  );
}

function EyeOffIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M8.1 5c.6-.14 1.24-.21 1.9-.21 5.4 0 8.5 5.5 8.5 5.5a15.6 15.6 0 0 1-2.66 3.32" />
      <path d="M12.6 12.7A3 3 0 0 1 8 8.9" />
      <path d="M4.9 6.3A15.5 15.5 0 0 0 1.5 10S4.6 15.5 10 15.5c1.2 0 2.28-.27 3.23-.7" />
      <path d="m2.5 2.5 15 15" />
    </svg>
  );
}

export function LoginForm({ onSignedIn }: { onSignedIn: (user: AgencyUser) => void }) {
  const emailFieldId = useId();
  const passwordFieldId = useId();
  const emailErrorId = `${emailFieldId}-error`;
  const passwordErrorId = `${passwordFieldId}-error`;

  const errorRef = useRef<HTMLDivElement>(null);

  // Visibility is view state only. The value itself is never copied out of the
  // form — toggling swaps the input's `type` and touches nothing else, so there
  // is no second place the password briefly lives.
  const [passwordVisible, setPasswordVisible] = useState(false);

  const {
    register, handleSubmit, formState: { errors }, setValue, setFocus,
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
    mode: 'onSubmit',
  });

  const loginMutation = useLogin(onSignedIn);
  const failure = loginMutation.error ? describeLoginFailure(loginMutation.error) : null;

  useEffect(() => {
    if (!failure) return;

    // The message is announced either way — it is a role="alert" live region.
    // Focus goes wherever the next useful action is, and only one place can
    // have it:
    //
    //   credential or form problem -> the cleared password field, because
    //     retyping it is exactly what the user must do next;
    //   anything else (403, 415, 429, network) -> the message itself, because
    //     there is no field to correct and the explanation is the whole point.
    //
    // Clearing the password is likewise limited to the cases where the input
    // was the problem. Wiping it after a rate-limit or a network blip would
    // force a retype of something that was already correct.
    if (failure.isCredentialProblem || failure.kind === 'invalid_form') {
      setValue('password', '');
      setFocus('password');
    } else {
      errorRef.current?.focus();
    }
  }, [failure, setValue, setFocus]);

  const onSubmit = handleSubmit((values) => {
    loginMutation.reset();
    loginMutation.submit({ email: values.email.trim(), password: values.password });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {failure ? (
        <div ref={errorRef} tabIndex={-1}>
          <Alert tone="error" title="Could not sign in">
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}

      <div>
        <label htmlFor={emailFieldId} className="block text-sm font-medium">
          Email address
        </label>
        <input
          id={emailFieldId}
          type="email"
          autoComplete="username"
          spellCheck={false}
          autoCapitalize="none"
          aria-invalid={errors.email ? true : undefined}
          aria-describedby={errors.email ? emailErrorId : undefined}
          className="mt-1 w-full rounded-md border border-[var(--color-border-strong)]
                     bg-[var(--color-surface)] px-3 py-2 text-sm
                     aria-[invalid=true]:border-[var(--color-danger)]"
          {...register('email')}
        />
        {errors.email ? (
          <p id={emailErrorId} className="mt-1 text-sm text-[var(--color-danger)]">
            {errors.email.message}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor={passwordFieldId} className="block text-sm font-medium">
          Password
        </label>
        <div className="relative mt-1">
          <input
            id={passwordFieldId}
            type={passwordVisible ? 'text' : 'password'}
            autoComplete="current-password"
            aria-invalid={errors.password ? true : undefined}
            aria-describedby={errors.password ? passwordErrorId : undefined}
            // pr-11 keeps the value clear of the toggle rather than running under it.
            className="w-full rounded-md border border-[var(--color-border-strong)]
                       bg-[var(--color-surface)] py-2 pl-3 pr-11 text-sm
                       aria-[invalid=true]:border-[var(--color-danger)]"
            {...register('password')}
          />
          {/*
            type="button" is the load-bearing attribute: the HTML default inside
            a form is "submit", which would turn every reveal into a sign-in
            attempt and spend one of the ten the backend rate limit allows.

            A real <button> after the input in DOM order, so Tab reaches it
            between the field and Sign in, and Enter/Space activate it for free.
            The accessible name changes with the state — aria-pressed alone
            would leave a screen-reader user guessing which way it is pointing.
          */}
          <button
            type="button"
            onClick={() => setPasswordVisible((visible) => !visible)}
            aria-label={passwordVisible ? 'Hide password' : 'Show password'}
            aria-pressed={passwordVisible}
            aria-controls={passwordFieldId}
            className="absolute inset-y-0 right-0 flex w-11 items-center justify-center
                       rounded-r-md text-[var(--color-ink-muted)]
                       hover:text-[var(--color-ink)]"
          >
            {passwordVisible ? <EyeOffIcon /> : <EyeIcon />}
          </button>
        </div>
        {errors.password ? (
          <p id={passwordErrorId} className="mt-1 text-sm text-[var(--color-danger)]">
            {errors.password.message}
          </p>
        ) : null}
      </div>

      <Button
        type="submit"
        loading={loginMutation.isSubmitting}
        loadingLabel="Signing in…"
      >
        Sign in
      </Button>
    </form>
  );
}
