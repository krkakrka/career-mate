/** One question on an application form, normalised across boards. */
export interface FormField {
  title: string;
  /** Normalised kind. `unknown` is honest — a board can add a type we have never seen. */
  type: FormFieldType;
  required: boolean;
  /** The board's own help text, plain, or null. */
  description: string | null;
}

/**
 * The kinds worth distinguishing when deciding whether to start an
 * application tonight.
 *
 * Deliberately coarse. The question a person is asking is "how much writing
 * is this and what do I need to hand", so `long-text` and `file` earn their
 * own kinds while every short single-line input collapses into `text`.
 */
export type FormFieldType = 'text' | 'long-text' | 'file' | 'boolean' | 'choice' | 'location' | 'unknown';

export interface ApplicationForm {
  provider: string;
  /** The posting's title as the *form* API reports it, which can differ from the tracked role's. */
  title: string | null;
  fields: FormField[];
  /** Pay as the board states it, where it says so. Ashby exposes this; Greenhouse does not. */
  compensationSummary: string | null;
  /** When applications close, where the board says. */
  deadline: string | null;
}

/** The counts that answer "is this a resume drop or an evening's work". */
export function summarizeForm(form: ApplicationForm): {
  total: number;
  required: number;
  essays: number;
  files: number;
} {
  const required = form.fields.filter((field) => field.required);
  return {
    total: form.fields.length,
    required: required.length,
    // Counted among *required* fields only: an optional essay is an
    // opportunity, a required one is the reason tonight is not the night.
    essays: required.filter((field) => field.type === 'long-text').length,
    files: required.filter((field) => field.type === 'file').length,
  };
}
