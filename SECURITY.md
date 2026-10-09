# Security Policy

## Supported versions

| Version | Supported |
| --- | --- |
| 0.11.x (latest) | Yes |
| < 0.11 | No |

Only the latest published release receives security fixes. Upgrade to the latest
version before reporting an issue that may already be resolved.

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability
reporting. Do **not** open a public issue, and do not disclose the problem
publicly before a fix is available.

1. Open the [Security tab](https://github.com/vheins/opencode-asynchronous-agent/security)
   of the repository.
2. Select **Report a vulnerability** to open a
   [private security advisory](https://github.com/vheins/opencode-asynchronous-agent/security/advisories/new).
3. Include:
   - a description of the issue and its impact;
   - the affected version(s);
   - steps to reproduce, with a minimal example if possible;
   - any suggested fix or mitigation.

The report and its discussion stay private between you and the maintainers until
an advisory is published.

## What to expect

- We will acknowledge the report and assess the impact.
- We will work on a fix and keep you informed of progress.
- We will credit you in the published advisory unless you prefer to stay
  anonymous.
- We will coordinate a disclosure timeline with you once a fix is ready.

## Scope

This project is an OpenCode plugin that runs locally. In scope are issues in the
plugin code in this repository, such as unsafe handling of local files or
credentials, or a way to escape the plugin's intended behaviour. Issues in
OpenCode itself or in third-party dependencies should be reported to their own
maintainers.
