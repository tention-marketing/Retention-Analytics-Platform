import { ApiError, toDisplayMessage } from '@/api/errors';
import { Alert } from './Alert';
import { Button } from './Button';

interface ErrorPanelProps {
  error: unknown;
  title?: string;
  /** Shown only when the error is actually worth retrying. */
  onRetry?: () => void;
  retrying?: boolean;
}

/**
 * The safe way to show a failure.
 *
 * Renders ONLY normalized, allowlisted text: ApiError.message is either a
 * backend message that passed isDisplayableMessage() or a fixed per-status
 * sentence. An unknown thrown value collapses to a generic sentence rather than
 * having its `.message` read — that is how a stack trace or an internal
 * exception string would otherwise reach the screen.
 *
 * Nothing here logs. A console.error of the caught value is the most common way
 * a credential ends up in a browser log, and there is no version of this
 * component that does it.
 */
export function ErrorPanel({ error, title = 'Something went wrong', onRetry, retrying }: ErrorPanelProps) {
  const message = toDisplayMessage(error);
  const apiError = error instanceof ApiError ? error : null;
  const canRetry = onRetry !== undefined && (apiError?.retryable ?? false);

  return (
    <Alert tone="error" title={title}>
      <p>{message}</p>

      {apiError?.isRateLimited && apiError.retryAfterSeconds !== null ? (
        <p className="mt-1">
          Try again in {apiError.retryAfterSeconds} second
          {apiError.retryAfterSeconds === 1 ? '' : 's'}.
        </p>
      ) : null}

      {apiError?.fieldErrors ? (
        <ul className="mt-2 list-disc space-y-0.5 pl-5">
          {Object.entries(apiError.fieldErrors).map(([field, fieldMessage]) => (
            <li key={field}>
              <span className="font-medium">{field}:</span> {fieldMessage}
            </li>
          ))}
        </ul>
      ) : null}

      {canRetry ? (
        <div className="mt-3">
          <Button variant="secondary" onClick={onRetry} loading={retrying === true}>
            Try again
          </Button>
        </div>
      ) : null}
    </Alert>
  );
}
