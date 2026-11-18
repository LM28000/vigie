#!/usr/bin/env python3
"""Régénère server/src/data/air_stations.tsv : les coordonnées des stations de mesure de la qualité de l'air.

Source : « Dataset D » (métadonnées des stations, points de prélèvement et réseaux, format XML) du jeu
« Données temps réel de mesure des concentrations de polluants atmosphériques réglementés » (LCSQA / INERIS) :
https://www.data.gouv.fr/datasets/5b98b648634f415309d52a50/ — il est mis à jour une à deux fois par an, et son adresse
change à chaque version (la liste des ressources est sur l'API de data.gouv.fr).

Usage : python3 -I server/scripts/air_stations.py fr-2026-d-XXXX.xml > server/src/data/air_stations.tsv

Le fichier fait 40 Mo : on le lit ligne à ligne, sans construire d'arbre. Une station par ligne, séparée par des
tabulations : code (celui de la colonne « code site » du flux E2), latitude, longitude, commune, nom. Seules les
stations de métropole et de Corse sont gardées (l'outre-mer est hors de la carte).
"""
import re
import sys

SUD, OUEST, NORD, EST = 41.0, -5.5, 51.5, 10.0


def stations(chemin):
    courante = None
    with open(chemin, encoding="utf-8") as fichier:
        for ligne in fichier:
            if "<aqd:AQD_Station " in ligne:
                courante = {}
            elif courante is None:
                continue
            elif "</aqd:AQD_Station>" in ligne:
                if {"code", "nom", "pos"} <= courante.keys():
                    yield courante
                courante = None
            else:
                for cle, motif in (
                    ("code", r"<aqd:natlStationCode>(.*?)</aqd:natlStationCode>"),
                    ("commune", r"<aqd:municipality>(.*?)</aqd:municipality>"),
                    ("nom", r"<ef:name>(.*?)</ef:name>"),
                    ("pos", r"<gml:pos[^>]*>(.*?)</gml:pos>"),
                ):
                    trouve = re.search(motif, ligne)
                    if trouve:
                        courante[cle] = trouve.group(1).strip()


def main():
    vus = set()
    for s in sorted(stations(sys.argv[1]), key=lambda s: s["code"]):
        lat, lon = (float(v) for v in s["pos"].split())
        if s["code"] in vus or not (SUD <= lat <= NORD and OUEST <= lon <= EST):
            continue
        vus.add(s["code"])
        commune = re.sub(r"(\d)E\b", r"\1e", s.get("commune", "").title())  # « 4E » devient « 4e »
        champs = [s["code"], f"{lat:.5f}", f"{lon:.5f}", commune, s["nom"]]
        # Les noms contiennent des entités XML (&amp;, &apos;) : on les décode.
        print("\t".join(c.replace("&amp;", "&").replace("&apos;", "'").replace("&quot;", '"') for c in champs))


main()
