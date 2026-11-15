# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes, which runs as two
containers: the main one (talks to Gladys) and the `receiver` sub-container (the UDP port).

- **Stored data**: nothing. `/data` stays empty; the samples are analysed in memory and dropped.
- **Secrets**: none. The integration uses no account and no API key; the station code is public.
- **Network**: the receiver listens on one UDP port, published on the LAN on a host port chosen by
  Gladys. Anyone on the LAN can send datagrams to it: they are capped at 40 per second per sender, 200 in all
  (a flood from many spoofed addresses can still crowd the Shake out),
  and 8 KB each, samples bounded to 24 bits,
  parsed as numbers only, and the optional "Address of the Shake" setting ignores every other sender.
  The link between the two containers stays on the private network of the integration. Outbound, the
  main container reaches `https://data.raspberryshake.org` only.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the Raspberry Shake device and services.
