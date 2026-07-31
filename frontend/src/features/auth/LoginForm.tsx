import { useEffect, useId, useRef } from 'react';
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

export function LoginForm({ onSignedIn }: { onSignedIn: (user: AgencyUser) => void }) {
  const emailFieldId = useId();
  const passwordFieldId = useId();
  const emailErrorId = `${emailFieldId}-error`;
  const passwordErrorId = `${passwordFieldId}-error`;

  const errorRef = useRef<HTMLDivElement>(null);

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
        <input
          id={passwordFieldId}
          type="password"
          autoComplete="current-password"
          aria-invalid={errors.password ? true : undefined}
          aria-describedby={errors.password ? passwordErrorId : undefined}
          className="mt-1 w-full rounded-md border border-[var(--color-border-strong)]
                     bg-[var(--color-surface)] px-3 py-2 text-sm
                     aria-[invalid=true]:border-[var(--color-danger)]"
          {...register('password')}
        />
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
