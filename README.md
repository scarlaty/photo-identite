# Photo d'identité 10×15

Outil web qui transforme une photo de portrait en **photos d'identité 35×45 mm** aux règles de
la carte nationale d'identité et du passeport français, disposées sur une **planche 10×15** de
6 photos à faire tirer (6 identiques, ou 3 personnes × 2).

Tout se passe dans le navigateur : les photos ne quittent jamais l'appareil. Les moteurs (MediaPipe,
onnxruntime-web) sont chargés depuis le CDN jsDelivr en version figée, et le modèle de détourage
depuis Hugging Face.

> **Limite administrative.** Pour une carte d'identité ou un passeport, l'administration demande
> une photo « réalisée par un professionnel ou dans une cabine utilisant un système agréé par le
> ministère de l'Intérieur » ([service-public.fr, F10619](https://www.service-public.gouv.fr/particuliers/vosdroits/F10619)).
> L'outil respecte les règles techniques, mais une photo faite soi-même peut être refusée en mairie.
> Elle convient aux autres usages (badges, cartes de transport, licences sportives, dossiers…).

## Règles appliquées

Sources : service-public.fr, fiche F10619 (vérifiée le 08/10/2026), et affiche du ministère de
l'Intérieur sur la norme ISO/IEC 19794-5:2005.

| Règle | Comment l'outil la traite |
|---|---|
| 35 × 45 mm | Rendu à la taille exacte : 827×1063 px à 600 dpi (photo seule), 413×531 px à 300 dpi (planche) |
| Visage de 32 à 36 mm, du menton au sommet du crâne hors cheveux | Cadrage automatique à 34 mm, milieu de la plage (réglable de 32,5 à 35,5). Crâne dégagé (rasé, chauve) : sommet **mesuré** sur le détourage grâce à la segmentation des cheveux. Sinon, sommet **estimé** sous les cheveux (yeux → crâne = 0,85 × yeux → menton, calibré sur des crânes dégagés), borné par le haut réel de la tête, et signalé « à vérifier sur l'aperçu ». Le curseur **Sommet du crâne** permet de placer ce sommet à la main (la photo se recale à la taille réglée) ; le contrôle reste « à vérifier », l'alignement étant fait à l'œil. **Ovale de contrôle** : gabarit comme en cabine, le visage (menton → sommet du crâne) doit tenir entre l'ovale de 32 mm et celui de 36 mm |
| Yeux dans la « zone des yeux » (50 à 70 % de la hauteur depuis le bas) | Vérifié ; zone affichée sur l'aperçu |
| Tête droite, de face | Inclinaison corrigée automatiquement (contrôlée au-delà de 8°) ; rotation latérale contrôlée |
| Fond uni, clair, blanc interdit | Sujet détouré, fond remplacé par gris clair, bleu clair ou gris perle (contrôle : clair mais jamais blanc) |
| Ni sur- ni sous-exposée, sans ombre | Exposition mesurée sur le front et les joues, corrigée si hors plage ; écart d'éclairage entre les joues signalé |
| Nette | Netteté mesurée (laplacien) |
| Expression neutre, bouche fermée, yeux ouverts | Contrôlés (expressions du visage détectées par MediaPipe) |
| Tête nue, oreilles dégagées, lunettes, regard, moins de 6 mois | Liste à cocher (non vérifiable de façon fiable par logiciel) |

Les retouches proposées (luminosité, contraste, ombres, teinte, couleurs) ne touchent que
l'exposition et la couleur du sujet, jamais les traits du visage.

## Impression

- Fichier JPEG à **300 dpi** (1800×1200 px) ou **600 dpi** (3600×2400 px), résolution inscrite dans le fichier.
- Tirage **10×15 « sans recadrage »** (taille réelle) en laboratoire ou borne ; à la maison, échelle 100 %.
- Une barre de **10 mm** est imprimée dans la marge pour vérifier que le tirage n'a pas été redimensionné.
- Repères de coupe aux coins de chaque photo.

## Prise de vue

Le bouton **Caméra** ouvre une prise de vue guidée : ovale de placement et conseils en direct
(distance, tête droite, regard, expression neutre, lumière, ombre sur une joue). La photo se
déclenche seule après un compte à rebours quand tout est bon. Une photo choisie dans la galerie
fonctionne aussi, y compris une photo en pied (le visage est recherché par zones).

Conseils :

- Face à une fenêtre (lumière douce et de face), à 1,5–2 m, téléphone à hauteur des yeux, zoom ×2
si possible (moins de déformation), visage neutre, cheveux dégagés. Une photo en pleine résolution
donne au moins 300 dpi utiles.

## Développement

```bash
npm start   # serveur local http://localhost:8080
npm test    # tests unitaires (node --test)
```

Détourage : BEN2 (ONNX, onnxruntime-web, WebGPU sinon WebAssembly) — repris de
[detourage-panini](https://github.com/scarlaty/detourage-panini). Repères du visage : MediaPipe
Face Landmarker.
