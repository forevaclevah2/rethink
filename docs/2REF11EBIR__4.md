# 2REF11EBIR__4 — LG LF21G6200S (US 3-door counter-depth, ADA)

Support for a refrigerator model that reports a **65-byte status body** instead of
the 68 bytes `2REF11EIDA__4` expects. Everything else about the protocol is the
shared fridge layout.

## Why this file exists

If a future upstream change breaks this handler, this document should contain
enough to rebuild it from scratch without owning the appliance.

## The appliance

| | |
|---|---|
| Model | LG LF21G6200S, product code GV-B218HSNB.ASTCNA0 |
| Model ID (`meta.modelId`) | `2REF11EBIR__4` |
| DeviceType | 101 (refrigerator) |
| Platform | thinq2, protocolVer 2, AABB framing |
| Modem | RTK_RTL8720cm, `clip_ble_v1.9.196` |
| Firmware | `clip_v2.00.15.05-SDK-8-RELEASE` |

## How the status frame was obtained

The unit does **not** volunteer `10EB`/`10EC`. Left alone it only emits its own
telemetry — `100A` (523 B, changes constantly), plus static `10C5` (56 B),
`103E` (11 B), `1018` (10 B). Those are not the HA status block.

Sending the family-wide status query makes it answer in ~200 ms:

```
->  AA0EF0ED1211010000010400EBBB      (F0ED status request; this is what start() sends)
<-  AA4710EB0207090102020600...90BB   (10EB initial status, 71 B)
```

That is why `start()` must send the query. Drop it and the entities never populate.

### The capture, verbatim

```
AA4710EB0207090102020600000001FFFFFF00FFFF00FFFFFFFFFFFFFF02000101FF0000FF01FF64
00FFFFFF01FF00FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF007890BB
```

- frame 71 B, declared length `0x47`
- checksum `0x90` — verifies as `(sum(bytes[:-2]) & 0xff) ^ 0x55`
- inner (after AA/len, before cksum/BB) = 67 B → status body = **65 B**

### Decoded

Field order is `fridge_common.STATUS_FIELDS`, same as `2REF11EIDA__4`:

| Idx | Field | Raw | Meaning |
|---|---|---|---|
| 1 | fridgeSetpoint | 7 | 37 °F (`44 - raw`) |
| 2 | freezerSetpoint | 9 | −3 °F (`6 - raw`) |
| 3 | expressFreeze | 1 | off (1=off, 2=on) |
| 7 | anyDoorOpen | 0 | closed |
| 8 | tempUnit | 0 | Fahrenheit |
| 10 | displayLock | 1 | unlocked |
| 13 | convertibleTemp | 0xFF | absent — 3-door has no flex drawer |

37 °F / −3 °F are LG's factory defaults, which is what makes this decode
trustworthy rather than a coincidence of offsets.

## Why the buffer is short, and why that is expected

`fridge_common.ts` already says it:

> These appear to be shared across various fridge models. **The buffer is
> truncated for lower-end models.**

`unpackStatus()` is written to tolerate it (`if (buf.length > index)`). The only
thing standing in the way was `2REF11EIDA__4.processAABB`, which matches on
`buf.length === 2 + 68` exactly and therefore silently drops a 67-byte inner.

This handler matches on a **range** instead of an exact length, so a firmware
update that pads or trims a byte degrades to "a field is missing" rather than
going completely silent.

## Read-only, deliberately

Reads are verified against the real appliance. **Writes are not.**

`2REF11EIDA__4` commands with an `F017` frame whose length (`0x69`) is sized for
its 68-byte layout. This model's write-frame length is unknown, and sending a
wrong-length `F017` to a refrigerator could silently move setpoints. So setpoints
are published as `sensor`, not `number`, and no command topics are advertised.

### Enabling control later

Note that `F017` is a **server-to-device command**. The appliance never emits one,
so it cannot be learned by watching the log while pressing buttons on the panel.
(An earlier revision of this document said otherwise; that was wrong.)

What the two known templates actually look like:

| Model | Status body | F017 frame | Length byte |
|---|---|---|---|
| `2REF11EIDA__4` | 68 B | 105 B | `0x69` |
| `2REF11EBIVPC4` | 43 B | 124 B | `0x7C` |

Two things follow. First, **F017 length does not track status-body length** — the
model with the larger status block has the shorter command frame. So the 65-byte
status body here implies nothing about the correct command length. Second, the two
templates share a **byte-identical 101-byte prefix**; EBIVPC4 is IDA's template
with 19 further bytes appended. Every field worth controlling here ([1] fridge,
[2] freezer, [3] express freeze, [8] unit, [14] sabbath) lives inside that shared
prefix.

Semantics are a write mask: `0xFF` means "leave this field alone", any other value
means "set it".

Suggested order of work:

1. Send `2REF11EIDA__4`'s 105-byte template **completely unmodified** — an all-mask
   no-op that should change nothing. Watch for a `10EC` status delta in reply.
2. If the device answers and the reported status is unchanged, the frame shape is
   accepted and the template is usable.
3. Then wire up one low-consequence field first (`display_lock` or `express_freeze`),
   confirm the status echoes the change, and only afterwards expose the setpoints.

Residual risk, stated honestly: the template carries a few fixed non-`0xFF` bytes.
If this model's parser expects a different layout, those could land on the wrong
fields. That is why step 1 sends the frame unmodified and step 3 starts with a
setting whose worst case is cosmetic rather than a temperature change.

## If upstream changes break this

Likely breakages, in order of probability:

1. **`fridge_common.STATUS_FIELDS` reordered** → the offset table above is the
   ground truth; re-derive indices from the field names.
2. **`AABBDevice.processData` changes its slicing** → it currently passes
   `buf.subarray(2, len-2)`, i.e. cmd bytes + body. `processAABB` assumes that.
3. **Discovery schema changes** → compare against a sibling like
   `2REF11EBIVPC4.ts`, which publishes the same component shapes.

The unit test (`tests/cloud/devices/2REF11EBIR__4.test.ts`) asserts against the
verbatim capture above, so a regression shows up as a failing test rather than a
silently empty device.

## Upstreaming

This is written to be upstreamable to `anszom/rethink` as-is. The frame capture
and decode table are the evidence a maintainer needs.
