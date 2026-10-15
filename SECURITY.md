# Security

Do not commit credentials, real `.env` / `.dev.vars` files, private keys, database files, backups, or personal learning data. Examples contain placeholders only. Store production credentials in Cloudflare Worker secrets and CI credentials in GitHub Actions secrets.

Report a suspected vulnerability privately through the repository owner’s GitHub profile. Do not put credentials, personal data, or working exploit tokens in a public issue. Rotate any exposed credential immediately; deleting a file does not remove it from Git history.

Deployments should use a Cloudflare token scoped to the relevant account and required Workers permissions. Pull requests run checks without production secrets; deployment runs only on the protected production branch. This repository does not automatically upgrade paid plans or migrate existing production data.
