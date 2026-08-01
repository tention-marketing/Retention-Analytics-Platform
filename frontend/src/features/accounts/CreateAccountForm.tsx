import { useEffect, useId, useMemo, useRef } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Alert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { describeAccountFailure } from './accountErrors';
import { isSelectableTimezone, listTimezones } from './timezones';
import { useCreateAccount } from './useAccounts';
import type { CreatedAccount } from '@/types/domain';

/**
 * What this form is allowed to assert, and nothing more.
 *
 * NAME: required, and required after trimming — "   " is a blank name wearing a
 * disguise, and the backend rejects it too. There is deliberately NO uniqueness
 * rule: nothing in the schema or the API says two brands cannot share a name,
 * agencies really do run "Acme (US)" and "Acme (EU)", and a client-side
 * uniqueness check would be inventing a business rule the product does not have.
 *
 * TIMEZONE: required, and validated against ICU rather than merely non-empty.
 * The select only offers valid zones, so this catches the cases a select cannot:
 * a stale option after a form reset, and anything that reaches the field other
 * than by clicking it. The server validates again regardless — see the note in
 * timezones.ts about which of the two is the actual control.
 */
const createAccountSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a name for this brand.')
    .max(200, 'That name is too long.'),
  store_timezone: z
    .string()
    .min(1, 'Choose the store timezone.')
    .refine(isSelectableTimezone, 'Choose a valid timezone from the list.'),
});

type CreateAccountValues = z.infer<typeof createAccountSchema>;

interface CreateAccountFormProps {
  onCreated: (account: CreatedAccount) => void;
  onCancel: () => void;
}

export function CreateAccountForm({ onCreated, onCancel }: CreateAccountFormProps) {
  const nameFieldId = useId();
  const timezoneFieldId = useId();
  const nameErrorId = `${nameFieldId}-error`;
  const timezoneErrorId = `${timezoneFieldId}-error`;
  const timezoneHintId = `${timezoneFieldId}-hint`;

  const errorRef = useRef<HTMLDivElement>(null);

  // Built once. Enumerating and validating ~400 zone names on every keystroke
  // would be the most expensive thing on the page.
  const timezones = useMemo(() => listTimezones(), []);

  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<CreateAccountValues>({
    resolver: zodResolver(createAccountSchema),
    // EMPTY, not the agency user's own timezone. See timezones.ts: a default
    // that is right for the office and wrong for the store is a silent error.
    defaultValues: { name: '', store_timezone: '' },
    mode: 'onSubmit',
  });

  const createMutation = useCreateAccount(onCreated);
  const failure = createMutation.error ? describeAccountFailure(createMutation.error) : null;

  useEffect(() => {
    // The message is a role="alert" live region so it is announced either way;
    // moving focus to it puts the keyboard where the explanation is, since
    // neither field is necessarily the thing to correct.
    if (failure) errorRef.current?.focus();
  }, [failure]);

  const onSubmit = handleSubmit((values) => {
    createMutation.reset();
    createMutation.submit({
      // Trimmed here as well as by Zod's `.trim()`, so what is sent is exactly
      // what was validated. The backend trims again — it does not trust this.
      name: values.name.trim(),
      store_timezone: values.store_timezone.trim(),
    });
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {failure ? (
        <div ref={errorRef} tabIndex={-1}>
          <Alert tone="error" title="Could not create the account">
            <p>{failure.message}</p>
          </Alert>
        </div>
      ) : null}

      <div>
        <label htmlFor={nameFieldId} className="block text-sm font-medium">
          Account name
        </label>
        <input
          id={nameFieldId}
          type="text"
          autoComplete="off"
          spellCheck={false}
          aria-invalid={errors.name ? true : undefined}
          aria-describedby={errors.name ? nameErrorId : undefined}
          className="mt-1 w-full rounded-md border border-[var(--color-border-strong)]
                     bg-[var(--color-surface)] px-3 py-2 text-sm
                     aria-[invalid=true]:border-[var(--color-danger)]"
          {...register('name')}
        />
        {errors.name ? (
          <p id={nameErrorId} className="mt-1 text-sm text-[var(--color-danger)]">
            {errors.name.message}
          </p>
        ) : null}
      </div>

      <div>
        <label htmlFor={timezoneFieldId} className="block text-sm font-medium">
          Store timezone
        </label>
        <p id={timezoneHintId} className="mt-1 text-sm text-[var(--color-ink-muted)]">
          The brand&rsquo;s own timezone, not yours. Every daily figure is counted against it.
        </p>
        {/*
          A real <select>. On a phone this is the platform's own scrolling
          picker, which beats anything a combobox reimplementation would give
          us for ~400 options, and it comes with keyboard type-ahead for free.

          The placeholder option is `disabled` so it cannot be chosen back once
          the user has moved off it, and its value is '' so the required rule in
          the schema catches an untouched form.
        */}
        <select
          id={timezoneFieldId}
          defaultValue=""
          aria-invalid={errors.store_timezone ? true : undefined}
          aria-describedby={
            errors.store_timezone ? `${timezoneHintId} ${timezoneErrorId}` : timezoneHintId
          }
          className="mt-1 w-full rounded-md border border-[var(--color-border-strong)]
                     bg-[var(--color-surface)] px-3 py-2 text-sm
                     aria-[invalid=true]:border-[var(--color-danger)]"
          {...register('store_timezone')}
        >
          <option value="" disabled>
            Select a timezone…
          </option>
          {timezones.map((zone) => (
            <option key={zone} value={zone}>
              {zone.replace(/_/g, ' ')}
            </option>
          ))}
        </select>
        {errors.store_timezone ? (
          <p id={timezoneErrorId} className="mt-1 text-sm text-[var(--color-danger)]">
            {errors.store_timezone.message}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" loading={createMutation.isSubmitting} loadingLabel="Creating…">
          Create account
        </Button>
        <Button variant="secondary" onClick={onCancel} disabled={createMutation.isSubmitting}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
