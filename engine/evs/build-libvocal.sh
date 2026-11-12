#!/usr/bin/env bash
# build-libvocal.sh - download the 3GPP EVS float reference (TS 26.443) and build
# libvocal.so (the shim in libvocal_evs.c) on THIS machine.
#
# The 3GPP code is patent-encumbered (EVS is licensed through a patent pool)
# and published for standardisation/evaluation, so it is never committed to
# this repository or shipped in a prebuilt artefact: it is fetched here, at
# build time, by the person building their own engine image.
#
# Usage: build-libvocal.sh <out-dir> [work-dir]
#   Env: EVS_REF_URL     3GPP archive zip (default: TS 26.443 j00)
#        EVS_REF_SHA256  expected sha256 of that zip ("" skips the check)
#        CC, CFLAGS      compiler / extra flags
#        EVS_TEST=1      also build and run the offline round-trip test
# Output: <out-dir>/libvocal.so (only that: the out dir is copied into the image)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
out=${1:?usage: build-libvocal.sh <out-dir> [work-dir]}
work=${2:-$(mktemp -d)}
url=${EVS_REF_URL:-https://www.3gpp.org/ftp/Specs/archive/26_series/26.443/26443-j00.zip}
sha=${EVS_REF_SHA256-0186e1c977927c5c67449b72abeba985eed80772102f7eaa48128119d9a17d27}
cc=${CC:-cc}

mkdir -p "$out" "$work"
out=$(cd "$out" && pwd)
cd "$work"

if [ ! -s ref.zip ]; then
    echo "build-libvocal: downloading $url"
    curl -fsSL --retry 3 -o ref.zip.part "$url"
    mv ref.zip.part ref.zip
fi
if [ -n "$sha" ]; then
    echo "$sha  ref.zip" | sha256sum -c -
fi

# The spec archive wraps the code in a second zip (*ANSI-C_source_code.zip).
rm -rf spec src
mkdir spec src
unzip -q -o ref.zip -d spec
inner=$(find spec -iname '*ANSI-C_source_code*.zip' | head -n1)
if [ -n "$inner" ]; then
    unzip -q -o "$inner" -d src
else
    cp -r spec/. src/
fi
code=$(dirname "$(find src -path '*/lib_com/prot.h' | head -n1)")
code=$(dirname "$code")
[ -d "$code/lib_enc" ] && [ -d "$code/lib_dec" ] || { echo "build-libvocal: unexpected archive layout" >&2; exit 1; }

# Only shared mutable globals of the float code: the basic-op Overflow/Carry
# flags (basop32.c/.h). Make them thread-local so instances on different
# Asterisk threads cannot race on them (each user resets them before reading).
sed -i -E 's/^Flag (Overflow|Carry) = 0;/__thread Flag \1 = 0;/' "$code/lib_com/basop32.c"
sed -i -E 's/^extern Flag Overflow, Overflow2;/extern __thread Flag Overflow; extern Flag Overflow2;/; s/^extern Flag Carry;/extern __thread Flag Carry;/' \
    "$code/lib_com/basop32.h"
grep -q '__thread Flag Overflow = 0;' "$code/lib_com/basop32.c" || { echo "build-libvocal: basop32.c patch failed" >&2; exit 1; }
grep -q 'extern __thread Flag Overflow;' "$code/lib_com/basop32.h" || { echo "build-libvocal: basop32.h patch failed" >&2; exit 1; }

# Everything except the CLI front ends (encoder/decoder main() and the VoIP
# file client, which use the mains' 'frame' counter).
srcs=$(find "$code/lib_com" "$code/lib_enc" "$code/lib_dec" -name '*.c' \
        ! -path '*/lib_enc/encoder.c' ! -path '*/lib_dec/decoder.c' \
        ! -path '*/lib_dec/voip_client.c' | sort)
incs="-I$code/lib_com -I$code/lib_enc -I$code/lib_dec"
# -ffp-contract=off keeps the float maths close to the reference build;
# -fvisibility=hidden exports only the VOCAL_API symbols.
flags="-O2 -fPIC -fvisibility=hidden -ffp-contract=off -DNDEBUG -w ${CFLAGS:-}"

mkdir -p obj
objs=()
for f in $srcs "$here/libvocal_evs.c"; do
    o="obj/$(basename "$(dirname "$f")")_$(basename "$f" .c).o"
    objs+=("$o")
    $cc $flags $incs -I"$here" -c "$f" -o "$o" &
    # bounded parallelism
    while [ "$(jobs -rp | wc -l)" -ge "$(nproc)" ]; do wait -n; done
done
wait
# shellcheck disable=SC2086 # CFLAGS on the link too (sanitizers, LTO)
$cc -shared ${CFLAGS:-} -o "$out/libvocal.so" "${objs[@]}" -lm -Wl,-z,defs -Wl,--as-needed
echo "build-libvocal: built $out/libvocal.so"

if [ "${EVS_TEST:-0}" = 1 ]; then
    $cc -O2 -Wall -Wextra -I"$here" -o "$work/test_libvocal" "$here/test_libvocal.c" -ldl -lm -lpthread
    "$work/test_libvocal" "$out/libvocal.so"
fi
