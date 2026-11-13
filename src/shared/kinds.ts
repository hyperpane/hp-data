// Every kind of connection Data can make: what it's called, which engine
// speaks to it, the family of window it opens in, and the fields its form
// asks for. A kind is a preset of an engine (Supabase is PostgreSQL with
// a host to fill in, MinIO is S3 with an endpoint), so adding one is a few
// lines here.
//
// The kinds are in kinds/: their types, the fields they share, the
// catalog, the form's SSH, TLS and Options tabs, and their values.

export * from './kinds/types.ts';
export { KINDS } from './kinds/catalog.ts';
export { SSH_ENGINES, SSH_FIELDS, TLS_ENGINES, TLS_FIELDS } from './kinds/sections.ts';
export * from './kinds/values.ts';
