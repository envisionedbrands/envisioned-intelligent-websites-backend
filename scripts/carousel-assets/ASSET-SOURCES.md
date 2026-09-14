# Studio carousel runtime assets

These files are signed runtime inputs. The renderer loads them from disk and
never fetches a font or image from the network.

## Fonts

All font binaries were copied without modification from the official Google
Fonts repository at commit
`ade3d1533e06b2b1462ffcde8e08b129627ca360`. Each family is distributed under
the SIL Open Font License 1.1; the exact upstream license text for each family
is beside the binaries.

| Local file | Upstream path | SHA-256 |
| --- | --- | --- |
| `fonts/Inter-Variable.ttf` | `ofl/inter/Inter[opsz,wght].ttf` | `29160a80ff49ddcab2c97711247e08b1fab27a484a329ce8b813d820dc559031` |
| `fonts/Inter-Italic-Variable.ttf` | `ofl/inter/Inter-Italic[opsz,wght].ttf` | `acd98e64795781b2058f07b18475e0ecee2a0fe2b42a49e2f9e37d0d6bf66ce6` |
| `fonts/Inter-Tight-Variable.ttf` | `ofl/intertight/InterTight[wght].ttf` | `b81b73dcb64df3c230cabade7df6c5773bf863233f24c9ee51087519f1f88b6f` |
| `fonts/Inter-Tight-Italic-Variable.ttf` | `ofl/intertight/InterTight-Italic[wght].ttf` | `15d3edf0c3d2560658529b8c4c7398d06c730a4695484c680b6c9ca9e4385be2` |
| `fonts/Fraunces-Variable.ttf` | `ofl/fraunces/Fraunces[SOFT,WONK,opsz,wght].ttf` | `177ff6c0f14e5550a3c624247cd1189611d4eb65d000b14944c63d967958abbb` |
| `fonts/Fraunces-Italic-Variable.ttf` | `ofl/fraunces/Fraunces-Italic[SOFT,WONK,opsz,wght].ttf` | `b24448c43702fac4ee856781d461a0dfba8d8e594b6e8e190234b75fed2c0e01` |
| `fonts/JetBrains-Mono-Variable.ttf` | `ofl/jetbrainsmono/JetBrainsMono[wght].ttf` | `48715a42ec242c21e9f02692891e147d022299a52e48d5e413e1a942193ffeda` |

Upstream: `https://github.com/google/fonts/tree/ade3d1533e06b2b1462ffcde8e08b129627ca360/ofl`

## House photography

The four Cobalt gradient plates are the exact BraveBrand-controlled assets
named by the signed Cobalt house pack. They replace CSS approximations.

| Local file | Canonical source | SHA-256 |
| --- | --- | --- |
| `images/cobalt-gradient-01.webp` | `https://playground.bravebrand.com/assets/prompt-media/cobalt-blue-01.webp` | `8b6ab2c1327bb52b878ae9f90c217cd8fbef56edbd59ef31d3cb5bd7490e68e4` |
| `images/cobalt-gradient-02.webp` | `https://playground.bravebrand.com/assets/prompt-media/cobalt-blue-02.webp` | `1c075adb2064ab63b6f329f6353fe4af804ceb0b2fcbc492edc896a1e508f872` |
| `images/cobalt-gradient-03.webp` | `https://playground.bravebrand.com/assets/prompt-media/cobalt-blue-03.webp` | `4a7d93402bb5da166f21a215b30e9c5da18d0e40e13a51d7ab66db2d56cadf4c` |
| `images/cobalt-gradient-04.webp` | `https://playground.bravebrand.com/assets/prompt-media/cobalt-blue-04.webp` | `b6670570be805a6e2be33b2d3aa66bcd77f511acd0562d556857a143b0d5018d` |

The Cobalt photographs are the exact Unsplash assets named by the signed
Cobalt house pack. They are used as part of composed carousel art, under the
Unsplash License (`https://unsplash.com/license`), and are not exposed as a
standalone photo library.

| Local file | Canonical source | SHA-256 |
| --- | --- | --- |
| `images/cobalt-photo-01.jpg` | `https://images.unsplash.com/photo-1551836022-d5d88e9218df?w=1400&h=1750&fit=crop` | `3a33dbdc1ba2e054472ff437d2c9cf2875d5ee13f560ad1501373519ba5594be` |
| `images/cobalt-photo-02.jpg` | `https://images.unsplash.com/photo-1573496359142-b8d87734a5a2?w=1400&h=1750&fit=crop` | `14e4ada00d4c256348accabb67f0d84af0de43cbbff738290bd26ed3fb0b6d3e` |

The Threshold photographs are the exact BraveBrand-controlled R2 assets named
by the signed Threshold house pack.

| Local file | Canonical source | SHA-256 |
| --- | --- | --- |
| `images/threshold-photo-01.jpg` | `https://images.bravebrand.com/orange/215a776301a85ad0d6273ebbb65945f8.jpg` | `36b77a24a160d5b024a40afa05a55657b78f8e5afc5e1436eddb44f82e9608cf` |
| `images/threshold-photo-02.jpg` | `https://images.bravebrand.com/orange/8d729f44878a1b026f806e311718e059.jpg` | `c76f3be5cf4cfd7219e90078f9d14a94f3f69d0e742250143a3e704df3596f2b` |
| `images/threshold-photo-03.jpg` | `https://images.bravebrand.com/orange/e57b5d2f09b0d7bf4b778f83f8c10096.jpg` | `6061231fffb56d10fbf44bf6286a9c1a423278b656b6614c3260dfb9adc9f5a4` |
| `images/threshold-photo-04.jpg` | `https://images.bravebrand.com/orange/fe1c40b5051451ec683dae3f4b6a93cb.jpg` | `e4fe7429fa966e8cdefe9a2e50ab8ab9d3076dad18816e64ca4090170a0aedd5` |
