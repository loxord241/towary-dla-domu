-- Anonymous site feedback (2026-08 client request).
--
-- Writes happen ONLY through the server route using the service-role key.
-- RLS is enabled with NO policies: anon/authenticated cannot read or write
-- the table directly, and the storefront never exposes stored feedback.
--
-- Anonymity contract: the table stores the message text and a timestamp
-- ONLY. There are no IP / user-agent / identifier columns by design.
-- Anti-flood layers:
--   1. per-IP sliding window — transient in-process memory, never persisted;
--   2. shared daily cap — a plain count over created_at (multi-instance
--      safe, identifier-free), enforced in app/api/feedback/route.ts.

CREATE TABLE IF NOT EXISTS public.feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message text NOT NULL CHECK (char_length(message) BETWEEN 10 AND 1000),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_feedback_created_at
  ON public.feedback (created_at);
