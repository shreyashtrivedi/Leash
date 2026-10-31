import { useState } from "react";
import type { FormEvent } from "react";

interface PasswordDialogProps {
  wrong: boolean;
  hint: string;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}

export function PasswordDialog({ wrong, hint, onSubmit, onCancel }: PasswordDialogProps) {
  const [value, setValue] = useState("");

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value) onSubmit(value);
  }

  return (
    <div className="overlay">
      <form
        className="password-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="password-title"
        onSubmit={submit}
        onKeyDown={(event) => event.key === "Escape" && onCancel()}
      >
        <h2 id="password-title">Dashboard password</h2>
        <p>Only a human with this password can approve payments or change the rules. Agents never receive it.</p>
        {hint && <p className="password-hint">Demo password: <code>{hint}</code></p>}
        <input
          type="password"
          aria-label="Dashboard password"
          autoFocus
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        {wrong && <p className="form-error">That password didn't work.</p>}
        <div className="password-actions">
          <button type="button" className="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!value}>
            Continue
          </button>
        </div>
      </form>
    </div>
  );
}
