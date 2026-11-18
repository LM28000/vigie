#!/bin/sh
# Régénère les icônes de l'application (PNG de web/public/icons) à partir des logos de design/logos,
# avec `sips` (fourni avec macOS) : aucune dépendance à installer. À relancer si le logo change.
#   vigie-mark.svg        -> icon-192.png, icon-512.png  (tuile aux coins arrondis, icône « any »)
#   vigie-icon-plein.svg  -> icon-maskable-512.png (plein cadre, marque dans la zone de sécurité),
#                            apple-touch-icon.png (180 px, iOS arrondit lui-même)
#   vigie-icon-mono.svg   -> icon-monochrome-512.png (alpha seul, pour les icônes thématiques d'Android)
set -eu
cd "$(dirname "$0")/.."
logos=../design/logos
out=public/icons
mkdir -p "$out"
png() { sips -s format png "$1" -z "$3" "$3" --out "$2" >/dev/null; }
png "$logos/vigie-mark.svg" "$out/icon-192.png" 192
png "$logos/vigie-mark.svg" "$out/icon-512.png" 512
png "$logos/vigie-icon-plein.svg" "$out/icon-maskable-512.png" 512
png "$logos/vigie-icon-plein.svg" "$out/apple-touch-icon.png" 180
png "$logos/vigie-icon-mono.svg" "$out/icon-monochrome-512.png" 512
