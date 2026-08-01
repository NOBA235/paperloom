BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS public.books_and_notes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NULL REFERENCES auth.users(id) ON DELETE SET NULL,
    fingerprint_hash text NOT NULL,
    raw_text text NOT NULL DEFAULT '',
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT books_and_notes_fingerprint_hash_nonempty CHECK (length(btrim(fingerprint_hash)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS books_and_notes_fingerprint_hash_idx
    ON public.books_and_notes (fingerprint_hash);

CREATE TABLE IF NOT EXISTS public.educational_gaps (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    note_id uuid NOT NULL REFERENCES public.books_and_notes(id) ON DELETE CASCADE,
    missing_concepts jsonb NOT NULL DEFAULT '[]'::jsonb,
    verified_resources jsonb NOT NULL DEFAULT '[]'::jsonb,
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT educational_gaps_note_id_unique UNIQUE (note_id)
);

CREATE INDEX IF NOT EXISTS educational_gaps_note_id_idx
    ON public.educational_gaps (note_id);

CREATE OR REPLACE FUNCTION public.paperloom_jwt_fingerprint_hash()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
    SELECT NULLIF(auth.jwt() ->> 'fingerprint_hash', '');
$$;

CREATE OR REPLACE FUNCTION public.paperloom_fingerprint_authorized(row_fingerprint_hash text)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog
AS $$
    SELECT COALESCE(row_fingerprint_hash = public.paperloom_jwt_fingerprint_hash(), false);
$$;

CREATE OR REPLACE FUNCTION public.paperloom_note_authorized(row_note_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
    SELECT EXISTS (
        SELECT 1
        FROM public.books_and_notes AS b
        WHERE b.id = row_note_id
          AND public.paperloom_fingerprint_authorized(b.fingerprint_hash)
    );
$$;

CREATE OR REPLACE FUNCTION public.paperloom_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS educational_gaps_set_updated_at ON public.educational_gaps;

CREATE TRIGGER educational_gaps_set_updated_at
BEFORE UPDATE ON public.educational_gaps
FOR EACH ROW
EXECUTE FUNCTION public.paperloom_set_updated_at();

ALTER TABLE public.books_and_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.books_and_notes FORCE ROW LEVEL SECURITY;

ALTER TABLE public.educational_gaps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.educational_gaps FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.books_and_notes FROM PUBLIC;
REVOKE ALL ON TABLE public.books_and_notes FROM anon, authenticated;

REVOKE ALL ON TABLE public.educational_gaps FROM PUBLIC;
REVOKE ALL ON TABLE public.educational_gaps FROM anon, authenticated;

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.books_and_notes TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.educational_gaps TO anon, authenticated;

GRANT USAGE ON SCHEMA public TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.books_and_notes TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.educational_gaps TO service_role;

REVOKE ALL ON FUNCTION public.paperloom_jwt_fingerprint_hash() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paperloom_jwt_fingerprint_hash() FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.paperloom_fingerprint_authorized(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paperloom_fingerprint_authorized(text) FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.paperloom_note_authorized(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paperloom_note_authorized(uuid) FROM anon, authenticated;

REVOKE ALL ON FUNCTION public.paperloom_set_updated_at() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.paperloom_set_updated_at() FROM anon, authenticated;

GRANT EXECUTE ON FUNCTION public.paperloom_jwt_fingerprint_hash() TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paperloom_fingerprint_authorized(text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.paperloom_note_authorized(uuid) TO anon, authenticated;

DROP POLICY IF EXISTS books_and_notes_select_by_fingerprint_claim ON public.books_and_notes;
DROP POLICY IF EXISTS books_and_notes_insert_by_fingerprint_claim ON public.books_and_notes;
DROP POLICY IF EXISTS books_and_notes_update_by_fingerprint_claim ON public.books_and_notes;
DROP POLICY IF EXISTS educational_gaps_select_by_fingerprint_claim ON public.educational_gaps;
DROP POLICY IF EXISTS educational_gaps_insert_by_fingerprint_claim ON public.educational_gaps;
DROP POLICY IF EXISTS educational_gaps_update_by_fingerprint_claim ON public.educational_gaps;

CREATE POLICY books_and_notes_select_by_fingerprint_claim
ON public.books_and_notes
FOR SELECT
TO anon, authenticated
USING (
    public.paperloom_fingerprint_authorized(fingerprint_hash)
);

CREATE POLICY books_and_notes_insert_by_fingerprint_claim
ON public.books_and_notes
FOR INSERT
TO anon, authenticated
WITH CHECK (
    public.paperloom_fingerprint_authorized(fingerprint_hash)
);

CREATE POLICY books_and_notes_update_by_fingerprint_claim
ON public.books_and_notes
FOR UPDATE
TO anon, authenticated
USING (
    public.paperloom_fingerprint_authorized(fingerprint_hash)
)
WITH CHECK (
    public.paperloom_fingerprint_authorized(fingerprint_hash)
);

CREATE POLICY educational_gaps_select_by_fingerprint_claim
ON public.educational_gaps
FOR SELECT
TO anon, authenticated
USING (
    public.paperloom_note_authorized(note_id)
);

CREATE POLICY educational_gaps_insert_by_fingerprint_claim
ON public.educational_gaps
FOR INSERT
TO anon, authenticated
WITH CHECK (
    public.paperloom_note_authorized(note_id)
);

CREATE POLICY educational_gaps_update_by_fingerprint_claim
ON public.educational_gaps
FOR UPDATE
TO anon, authenticated
USING (
    public.paperloom_note_authorized(note_id)
)
WITH CHECK (
    public.paperloom_note_authorized(note_id)
);

COMMIT;
