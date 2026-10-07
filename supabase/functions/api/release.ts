/* The release this copy of the API was deployed from — the git commit.
   scripts/deploy-api.mjs writes it just before deploying and puts "dev"
   back afterwards; error reports and /health carry it. */
export const RELEASE = "dev";
