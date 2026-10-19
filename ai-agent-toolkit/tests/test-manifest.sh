#!/usr/bin/env bash
# Manifest tests: every requested repo present, fields complete, status honest.
set -uo pipefail; . "$(dirname "$0")/_lib.sh"
M="$TK/config/repository-manifest.json"
check "manifest is valid JSON" jq empty "$M"
want=$(grep -c . "$T_DIR/requested-repos.txt"); got=$(jq '.repositories|length' "$M")
[ "$want" = "$got" ] && t_ok "manifest count $got == requested $want" || t_bad "manifest $got != requested $want"
while read -r r; do
  jq -e --arg r "$r" '.repositories[]|select(.repo==$r)' "$M" >/dev/null && t_ok "represented: $r" || t_bad "missing: $r"; done < "$T_DIR/requested-repos.txt"
miss=$(jq -r '.repositories[]|select((.name,.url,.category,.kind,.purpose,.install_method,.license,.installation_status,.security_notes)|(.==null or .==""))|.name' "$M")
[ -z "$miss" ] && t_ok "required fields present" || t_bad "empty fields: $miss"
dups=$(jq -r '.repositories|group_by(.repo)|map(select(length>1))|length' "$M"); [ "$dups" = 0 ] && t_ok "no duplicate repos" || t_bad "duplicate repos"
while IFS=$'\t' read -r n st p c; do
  case $st in
    retrieved) [ -d "$TK/$p" ] && [ -n "$c" ] && t_ok "retrieved ok: $n" || t_bad "$n marked retrieved but path/commit missing";;
    pointer-only) [ ! -d "$TK/$p" ] || [ -f "$TK/$p/POINTER.md" ] && t_ok "pointer ok: $n" || t_bad "$n pointer inconsistent";;
    *) t_bad "$n status $st";; esac
done < <(jq -r '.repositories[]|[.name,.installation_status,(.local_path//"-"),(.commit//"")]|@tsv' "$M")
check "skill-index valid and non-empty" jq -e '.count>0 and (.skills|length)==.count' "$TK/config/skill-index.json"
check "every indexed skill file exists" bash -c 'jq -r ".skills[].path" "$0/config/skill-index.json" | while read -r p; do [ -f "$0/$p" ] || exit 1; done' "$TK"
finish
