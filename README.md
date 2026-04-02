# Shared Mailbox Contact Lookup

A Node.js service that periodically syncs contacts from an Exchange Online shared mailbox via Microsoft Graph API and stores them in a local SQLite database. Provides a fast phone number lookup endpoint for caller identification.

## Features

- **Automatic sync** — Fetches contacts from Microsoft Graph on a configurable interval
- **Phone number lookup** — Matches against mobile, business, and home phone numbers
- **Normalized matching** — Strips formatting so `+49 (152) 373-51074` matches `4915237351074`
- **URI prefix handling** — Automatically strips `sip:`, `tel:`, `sips:` prefixes from lookup input
- **Configurable name format** — Display names as `First Last`, `Last, First`, or `Company (Name)`
- **Company name support** — Shows company affiliation in parentheses when available
- **Certificate auth** — Supports both client secret and certificate-based Azure AD authentication
- **Basic auth** — Optional HTTP Basic Authentication for API access
- **IP allowlisting** — Restrict access to trusted hosts only
- **HTTPS / mTLS** — Optional TLS with mutual certificate verification

## Prerequisites

- Node.js 18+
- An Azure AD app registration with `Contacts.Read` application permission for Microsoft Graph
- The shared mailbox email address

## Quick Start

```bash
# Clone the repository
git clone git@github.com:akandor/Shared-Mailbox-Contact-Lookup.git
cd Shared-Mailbox-Contact-Lookup

# Install dependencies
npm install

# Configure environment
cp .env.example .env
# Edit .env with your Azure AD credentials and preferences

# Start the server
npm start
```

## Configuration

Copy `.env.example` to `.env` and configure the following variables:

### Azure AD (required)

| Variable | Description |
|---|---|
| `TENANT_ID` | Azure AD tenant ID |
| `CLIENT_ID` | App registration client ID |
| `CLIENT_SECRET` | App registration client secret |
| `MAILBOX_EMAIL` | Shared mailbox email address |

### Certificate Authentication (optional)

Certificate auth takes precedence over client secret when both are configured.

| Variable | Description |
|---|---|
| `CERT_KEY_PATH` | Path to private key file (e.g. `./certs/private.key`) |
| `CERT_THUMBPRINT` | SHA-1 certificate thumbprint from Azure portal |

Place your private key in the `certs/` directory (gitignored by default).

### Server

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | Server listen port |
| `SYNC_INTERVAL_MINUTES` | `5` | Contact sync interval in minutes |
| `NAME_FORMAT` | `firstname` | Name display format (see below) |

### Security

| Variable | Default | Description |
|---|---|---|
| `TRUSTED_HOSTS` | *(empty)* | Comma-separated IP allowlist (e.g. `127.0.0.1,10.0.0.5`) |
| `USERNAME` | *(empty)* | Basic auth username (auth disabled if empty) |
| `PASSWORD` | *(empty)* | Basic auth password |
| `HTTPS` | `false` | Enable HTTPS server |
| `HTTPS_KEY_PATH` | `./certs/server.key` | TLS private key path |
| `HTTPS_CERT_PATH` | `./certs/server.crt` | TLS certificate path |
| `HTTPS_CA_PATH` | *(empty)* | CA certificate for mutual TLS (client cert verification) |
| `HTTPS_ONLY` | `false` | Redirect all HTTP requests to HTTPS |

> When `TRUSTED_HOSTS` is set, only listed IPs can connect. Basic auth is enforced independently — trusted hosts still need to authenticate.

### Name Format

The `NAME_FORMAT` variable controls how contact names are returned:

| Value | Example Output |
|---|---|
| `firstname` | `John Smith (Contoso)` |
| `lastname` | `Smith, John (Contoso)` |
| `company` | `Contoso (John Smith)` |

Company name is shown in parentheses when available. If a contact has no company, the parenthetical is omitted.

## API

### POST /lookup

Look up a contact by phone number.

**Request:**

```json
{
  "sessionId": "abc123",
  "dstUri": "+4915237351074"
}
```

The `dstUri` field accepts raw phone numbers or SIP/TEL URIs (`tel:+4915237351074`, `sip:+4915237351074`).

**Response (match found):**

```json
{
  "sessionId": "abc123",
  "name": "John Smith (Contoso)",
  "phone": "+4915237351074",
  "phoneType": "mobile"
}
```

**Response (no match):**

```json
{
  "sessionId": "abc123",
  "name": null
}
```

The `phoneType` field indicates which number matched: `mobile`, `business`, or `home`.

### GET /health

Returns service status and contact count.

```json
{
  "status": "ok",
  "contacts": 42
}
```

## Project Structure

```
src/
  index.js    Express server, middleware, routes
  db.js       SQLite schema, upsert, phone lookup
  graph.js    Microsoft Graph OAuth + contact fetching
  sync.js     Periodic sync logic
certs/        TLS & Azure AD certificates (gitignored)
```

## Azure AD Setup

1. Register a new app in **Azure Portal > App registrations**
2. Add API permission: **Microsoft Graph > Application > Contacts.Read**
3. Grant admin consent for the permission
4. For **client secret auth**: Create a secret under Certificates & secrets
5. For **certificate auth**: Upload your certificate under Certificates & secrets, note the thumbprint

## License

MIT
