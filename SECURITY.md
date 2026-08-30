# Security policy

## Supported versions

Security fixes are released for the latest published version of each package.
Older versions are not patched.

## Reporting a vulnerability

**Please do not open a public issue or pull request for a security problem.**

Report it privately through GitHub's
[private vulnerability reporting](https://github.com/HumeAI/hume-react-sdk/security/advisories/new),
or email <security@hume.ai>. You should get an acknowledgement within three
business days.

A report is most useful with the affected package and version, the browser and
platform, and the smallest reproduction you can manage.

## Scope

These packages handle Hume API keys and access tokens, request microphone
permission, and — in `@humeai/voice-embed` and `@humeai/voice-embed-react` —
exchange `postMessage` traffic with a cross-origin widget iframe. Findings that
touch credential handling, media permissions, or that message channel's origin
validation are especially welcome.

Vulnerabilities in the EVI API itself, rather than in these client packages,
should go to <security@hume.ai> directly.
