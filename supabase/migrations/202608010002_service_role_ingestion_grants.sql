BEGIN;

GRANT USAGE ON SCHEMA public TO service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE public.books_and_notes TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.educational_gaps TO service_role;

COMMIT;
