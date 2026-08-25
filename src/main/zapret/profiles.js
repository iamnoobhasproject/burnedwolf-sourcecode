// BURNEDWOLF DPI PROFILES
// Pure profile catalog + metadata. No process management here — engine.js
// spawns winws.exe, blockcheck.js scores profiles; both consume this module.
//
// Category prefixes:
//   bw_     -> Generic / Global (works in most regions)
//   tr_     -> Turkey-focused (Turk Telekom, Vodafone, Turkcell Superonline, TurkNet, D-Smart, Kablonet)
//   ru_     -> Russia / CIS (Rostelecom, MTS, Beeline, MegaFon, Yota)
//   eu_     -> Europe (UK, DE, FR ISPs that throttle YouTube/Discord)
//   mid_    -> Middle East / GCC
//   asia_   -> South / Central Asia
const { ipcMain } = require('electron');
const { FAKE_TLS_PATH, FAKE_QUIC_PATH } = require('./paths');
const { fakePayloadsAvailable } = require('./payloads');

const ZAPRET_PROFILES = {
    // ===== GENERIC / GLOBAL =====
    'bw_standard':       ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443', '--dpi-desync=fake', '--new', '--filter-tcp=80,443', '--dpi-desync=split2'],
    'bw_advanced':       ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig'],
    'bw_aggressive':     ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=badseq', '--dpi-desync-autottl=2'],
    'bw_ultra':          ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,badsum', '--dpi-desync-autottl=2'],
    'bw_discord_voice':  ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443,50000-65535', '--dpi-desync=fake', '--dpi-desync-repeats=6', '--new', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-autottl=2'],
    'bw_youtube_4k':     ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=split2', '--dpi-desync-split-pos=1', '--dpi-desync-repeats=6'],
    'bw_quic_pass':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443', '--dpi-desync=fake', '--dpi-desync-repeats=2', '--dpi-desync-fake-quic=quic_initial.bin'],
    'bw_tls_split':      ['--wf-tcp=80,443', '--filter-tcp=443', '--dpi-desync=split', '--dpi-desync-split-pos=2', '--dpi-desync-split-seqovl=652', '--dpi-desync-fooling=md5sig'],
    'bw_minimal':        ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=fake'],

    // ===== CLASSIC COMMUNITY RULESETS (zapret-discord-youtube) =====
    // These are the long-proven rulesets from the original Russian/Turkish
    // bypass community. They split UDP voice traffic (50000-65535) from
    // standard HTTPS/QUIC into its own filter chain, which is the trick that
    // gets Discord voice unstuck on aggressive DPI providers (TTNet fiber).
    'bw_classic_discord': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig'
    ],
    'bw_classic_universal': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split', '--dpi-desync-autottl', '--dpi-desync-fooling=md5sig'
    ],

    // ===== TURKEY (TR) =====
    // Türk Telekom (TTNet) — heavy SNI inspection on 443, light on 80
    'tr_ttnet_std':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig', '--dpi-desync-autottl=2', '--dpi-desync-repeats=6'],
    'tr_ttnet_youtube':  ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=badseq,md5sig', '--dpi-desync-autottl=4', '--dpi-desync-repeats=10'],
    // TTNet + Discord: voice UDP (50000-65535) gets its own filter chain with
    // --dpi-desync-any-protocol so each voice packet is fragmented, otherwise
    // Discord gets stuck on "Starting" because TTNet drops the voice handshake.
    'tr_ttnet_discord':  [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'
    ],
    // TTNet Fiber: even more aggressive — fiber lines have deeper inspection,
    // so we add badseq fooling and bump TTL/repeats. Use when discord_std fails.
    'tr_ttnet_fiber':    [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=8',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d4', '--dpi-desync-repeats=10',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-autottl=3', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-repeats=8'
    ],
    // Vodafone TR — aggressive QUIC drop, TLS 1.3 reassembly
    'tr_vodafone_std':   ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=badseq,hopbyhop2', '--dpi-desync-autottl=2'],
    'tr_vodafone_yt':    ['--wf-tcp=80,443', '--filter-tcp=443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=md5sig,badsum', '--dpi-desync-repeats=8', '--dpi-desync-autottl=2'],
    // Turkcell Superonline — fiber, aggressive deep inspection
    'tr_superonline':    ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'],
    'tr_superonline_d':  ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443,50000-65535', '--dpi-desync=fake', '--dpi-desync-repeats=8', '--new', '--filter-tcp=443', '--dpi-desync=fake,multisplit', '--dpi-desync-fooling=md5sig,badseq'],
    // TurkNet — relatively light DPI, often standard works
    'tr_turknet':        ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=fake', '--dpi-desync-fooling=md5sig', '--new', '--filter-udp=443', '--dpi-desync=fake'],
    // D-Smart / Kablonet — cable, moderate filtering
    'tr_dsmart':         ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=split2', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=md5sig'],
    'tr_kablonet':       ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig'],
    // Mobile carriers (legacy combined entry — kept for backward compatibility)
    'tr_mobile_std':     ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=badseq,md5sig', '--dpi-desync-autottl=2', '--dpi-desync-repeats=4'],
    // Per-carrier mobile profiles (3 big operators use different DPI vendors/tunings)
    'tr_mobile_tt':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=50000-65535', '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=3', '--dpi-desync-repeats=6'],
    'tr_mobile_vf':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=50000-65535', '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=hopbyhop2,md5sig', '--dpi-desync-autottl=2', '--dpi-desync-repeats=6'],
    'tr_mobile_tc':      ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=50000-65535', '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--new', '--filter-tcp=80,443', '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'],
    // Türksat Uydunet (satellite/fiber hybrid) — moderate inspection
    'tr_uydunet':        ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig', '--dpi-desync-autottl=3', '--dpi-desync-repeats=4'],

    // ===== TURKEY — ALL-IN-ONE (one profile, every protocol) =====
    // Same 4-chain architecture as Ultimate (QUIC + Voice UDP + TCP 80 + TCP 443)
    // but WITHOUT the fake-TLS/QUIC payload files — so these work even when the
    // GitHub download has failed or the user has no internet on first launch.
    // Each ISS variant tunes the TCP chain's fooling combo to match its DPI
    // vendor (Sandvine vs Allot vs lighter setups).
    'tr_ttnet_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80',            '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig',
        '--new',
        '--filter-tcp=443',           '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'
    ],
    'tr_vodafone_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80',            '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=hopbyhop2',
        '--new',
        '--filter-tcp=443',           '--dpi-desync=fake,split2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=hopbyhop2,md5sig', '--dpi-desync-repeats=6'
    ],
    'tr_superonline_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80',            '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig',
        '--new',
        '--filter-tcp=443',           '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6'
    ],
    'tr_turknet_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=4',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=4',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig'
    ],
    'tr_uydunet_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-autottl=3', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=4'
    ],
    'tr_dsmart_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=4',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=4',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=split2', '--dpi-desync-split-pos=1', '--dpi-desync-fooling=md5sig'
    ],
    'tr_kablonet_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=4',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=4',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=4'
    ],
    // Universal mobile All-in-One — works on TT Mobil / Vodafone Mobile / Turkcell Mobile
    // because mobile DPI uses common Sandvine-derived patterns
    'tr_mobile_all_in_one': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',           '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',   '--dpi-desync=fake', '--dpi-desync-any-protocol', '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',        '--dpi-desync=fake,disorder2', '--dpi-desync-autottl=2', '--dpi-desync-fooling=badseq,md5sig', '--dpi-desync-repeats=6'
    ],

    // ===== TURKEY — PRO (vendor-specific advanced fooling signatures) =====
    // These profiles use the strongest community-proven flag combinations for
    // each DPI vendor (Sandvine, Allot, Light/generic). They do NOT depend on
    // the fake-payload .bin files, so they ship offline-ready. Key differences
    // vs. plain profiles: split-seqovl=652 (defeats TLS 1.3 reassembly),
    // split-pos=2 with multisplit, 3-way fooling (md5sig + badseq + hopbyhop2),
    // and split TCP 80 / TCP 443 chains so the SNI-inspection layer can be
    // attacked separately from plain HTTP.
    'tr_ttnet_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=8',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d4', '--dpi-desync-repeats=10',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig,badseq',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=3', '--dpi-desync-fooling=md5sig,badseq,hopbyhop2',
        '--dpi-desync-repeats=8'
    ],
    'tr_vodafone_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,split2',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=hopbyhop2,md5sig',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,split2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=hopbyhop2,md5sig,badseq',
        '--dpi-desync-repeats=8'
    ],
    'tr_superonline_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=md5sig,badseq',
        '--dpi-desync-repeats=6'
    ],
    'tr_mobile_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,disorder2',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=badseq,md5sig',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,disorder2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=2', '--dpi-desync-fooling=badseq,md5sig,hopbyhop2',
        '--dpi-desync-repeats=8'
    ],
    // Universal TR aggressive — works on TTNet/Vodafone/Superonline simultaneously
    // by combining the strongest fooling set across vendors. Slightly slower
    // than vendor-specific Pro but the safest choice when ISP is uncertain.
    'tr_universal_pro': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=8',
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80,443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-split-seqovl=652',
        '--dpi-desync-autottl=3',
        '--dpi-desync-fooling=md5sig,badseq,hopbyhop2',
        '--dpi-desync-repeats=8'
    ],

    // ===== TURKEY — ULTIMATE (uses downloaded fake-TLS / fake-QUIC payloads) =====
    // These profiles wrap our fake desync packets in real Google ClientHello /
    // QUIC Initial captures. Sandvine (TTNet) and Allot (Superonline) DPI
    // vendors won't drop a packet that looks like a Google handshake, which
    // dramatically boosts the bypass rate — especially for Discord voice.
    // If the .bin files haven't been downloaded yet, profiles fall back to
    // their non-fake equivalents at spawn time (see applyGlobalProfileFlags).
    'tr_ttnet_ultimate': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-quic=${FAKE_QUIC_PATH}`,
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=8',
        '--new',
        '--filter-tcp=80',
        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2',
        '--dpi-desync-fooling=md5sig',
        '--new',
        '--filter-tcp=443',
        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-tls=${FAKE_TLS_PATH}`
    ],
    'tr_vodafone_ultimate': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-quic=${FAKE_QUIC_PATH}`,
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',
        '--dpi-desync=fake,split2', '--dpi-desync-autottl=2',
        '--dpi-desync-fooling=hopbyhop2,md5sig', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-tls=${FAKE_TLS_PATH}`
    ],
    'tr_superonline_ultimate': [
        '--wf-tcp=80,443', '--wf-udp=443,50000-65535',
        '--filter-udp=443',
        '--dpi-desync=fake', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-quic=${FAKE_QUIC_PATH}`,
        '--new',
        '--filter-udp=50000-65535',
        '--dpi-desync=fake', '--dpi-desync-any-protocol',
        '--dpi-desync-cutoff=d3', '--dpi-desync-repeats=6',
        '--new',
        '--filter-tcp=80,443',
        '--dpi-desync=fake,multisplit', '--dpi-desync-split-pos=2',
        '--dpi-desync-fooling=md5sig', '--dpi-desync-repeats=6',
        `--dpi-desync-fake-tls=${FAKE_TLS_PATH}`
    ],

    // ===== RUSSIA / CIS =====
    // Rostelecom — large state ISP, heavy YouTube throttling
    'ru_rostelecom':     ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=2', '--dpi-desync-repeats=6'],
    'ru_rostelecom_yt':  ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=md5sig', '--dpi-desync-autottl=4', '--dpi-desync-repeats=10', '--dpi-desync-fake-tls=tls_clienthello_www_google_com.bin'],
    // MTS / Beeline / MegaFon — mobile, TPROXY-like behavior
    'ru_mts':            ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,multisplit', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=2'],
    'ru_beeline':        ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,hopbyhop2'],
    'ru_megafon':        ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=fake,disorder', '--dpi-desync-fooling=md5sig'],
    // Yota — heavy QUIC filtering
    'ru_yota':           ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-udp=443', '--dpi-desync=fake', '--dpi-desync-repeats=4', '--new', '--filter-tcp=443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig,badsum'],

    // ===== EUROPE =====
    // UK ISPs (BT, Virgin, Sky) — court-ordered blocking
    'eu_uk_std':         ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig'],
    // German / French ISPs with light DPI
    'eu_de_fr':          ['--wf-tcp=80,443', '--filter-tcp=443', '--dpi-desync=split2', '--dpi-desync-split-pos=2'],

    // ===== MIDDLE EAST =====
    // Iran / UAE / Saudi — heavy filtering, multiple layers
    'mid_iran':          ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=md5sig,badseq,badsum', '--dpi-desync-autottl=4', '--dpi-desync-repeats=12'],
    'mid_uae':           ['--wf-tcp=80,443', '--wf-udp=443', '--filter-tcp=80,443', '--dpi-desync=fake,multisplit', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=3', '--dpi-desync-repeats=8'],

    // ===== ASIA =====
    'asia_in':           ['--wf-tcp=80,443', '--filter-tcp=80,443', '--dpi-desync=fake,split2', '--dpi-desync-fooling=md5sig', '--dpi-desync-autottl=2'],
    'asia_pk':           ['--wf-tcp=80,443', '--wf-udp=443,50000-65535', '--filter-tcp=80,443', '--dpi-desync=fake,disorder2', '--dpi-desync-fooling=md5sig,badseq', '--dpi-desync-autottl=3', '--dpi-desync-repeats=6']
};

// Profile metadata for UI categorization
const PROFILE_META = {
    'bw_standard':       { label: 'Standard',                  region: 'Generic' },
    'bw_advanced':       { label: 'Advanced',                  region: 'Generic' },
    'bw_aggressive':     { label: 'Aggressive',                region: 'Generic' },
    'bw_ultra':          { label: 'Ultra',                     region: 'Generic' },
    'bw_discord_voice':  { label: 'Discord Voice Optimized',   region: 'Generic' },
    'bw_youtube_4k':     { label: 'YouTube 4K Bypass',         region: 'Generic' },
    'bw_quic_pass':      { label: 'QUIC Passthrough',          region: 'Generic' },
    'bw_tls_split':      { label: 'TLS Split (Light)',         region: 'Generic' },
    'bw_minimal':        { label: 'Minimal',                   region: 'Generic' },
    'bw_classic_discord':   { label: 'Classic Discord (legacy)',   region: 'Generic' },
    'bw_classic_universal': { label: 'Classic Universal (legacy)', region: 'Generic' },
    'tr_ttnet_std':      { label: 'Türk Telekom — Standard',         region: 'Turkey' },
    'tr_ttnet_youtube':  { label: 'Türk Telekom — YouTube',          region: 'Turkey' },
    'tr_ttnet_discord':  { label: 'Türk Telekom — Discord',          region: 'Turkey' },
    'tr_ttnet_fiber':    { label: 'Türk Telekom Fiber — Discord+',   region: 'Turkey' },
    'tr_vodafone_std':   { label: 'Vodafone TR — Standard',    region: 'Turkey' },
    'tr_vodafone_yt':    { label: 'Vodafone TR — YouTube',     region: 'Turkey' },
    'tr_superonline':    { label: 'Superonline — Standard',    region: 'Turkey' },
    'tr_superonline_d':  { label: 'Superonline — Discord',     region: 'Turkey' },
    'tr_turknet':        { label: 'TurkNet',                   region: 'Turkey' },
    'tr_dsmart':         { label: 'D-Smart',                   region: 'Turkey' },
    'tr_kablonet':       { label: 'Kablonet',                       region: 'Turkey' },
    'tr_uydunet':        { label: 'Türksat Uydunet',                region: 'Turkey' },
    'tr_mobile_std':     { label: 'TR Mobile (combined, legacy)',   region: 'Turkey' },
    'tr_mobile_tt':      { label: 'TR Mobile — TT Mobil (4.5G/5G)', region: 'Turkey' },
    'tr_mobile_vf':      { label: 'TR Mobile — Vodafone',           region: 'Turkey' },
    'tr_mobile_tc':      { label: 'TR Mobile — Turkcell',           region: 'Turkey' },
    'tr_ttnet_ultimate':       { label: 'TT Ultimate (fake-TLS+QUIC)',          region: 'Turkey' },
    'tr_vodafone_ultimate':    { label: 'Vodafone Ultimate (fake-TLS+QUIC)',    region: 'Turkey' },
    'tr_superonline_ultimate': { label: 'Superonline Ultimate (fake-TLS+QUIC)', region: 'Turkey' },
    'tr_ttnet_pro':            { label: 'TT Pro (Sandvine signature)',          region: 'Turkey' },
    'tr_vodafone_pro':         { label: 'Vodafone Pro (Sandvine variant)',      region: 'Turkey' },
    'tr_superonline_pro':      { label: 'Superonline Pro (Allot signature)',    region: 'Turkey' },
    'tr_mobile_pro':           { label: 'TR Mobile Pro (Sandvine mobile)',      region: 'Turkey' },
    'tr_universal_pro':        { label: 'TR Universal Pro (multi-vendor)',      region: 'Turkey' },
    'tr_ttnet_all_in_one':       { label: 'TT All-in-One (Discord+YT+X)',          region: 'Turkey' },
    'tr_vodafone_all_in_one':    { label: 'Vodafone All-in-One (Discord+YT+X)',    region: 'Turkey' },
    'tr_superonline_all_in_one': { label: 'Superonline All-in-One (Discord+YT+X)', region: 'Turkey' },
    'tr_turknet_all_in_one':     { label: 'TurkNet All-in-One',                    region: 'Turkey' },
    'tr_uydunet_all_in_one':     { label: 'Uydunet All-in-One',                    region: 'Turkey' },
    'tr_dsmart_all_in_one':      { label: 'D-Smart All-in-One',                    region: 'Turkey' },
    'tr_kablonet_all_in_one':    { label: 'Kablonet All-in-One',                   region: 'Turkey' },
    'tr_mobile_all_in_one':      { label: 'TR Mobile All-in-One (universal)',      region: 'Turkey' },
    'ru_rostelecom':     { label: 'Rostelecom',                region: 'Russia' },
    'ru_rostelecom_yt':  { label: 'Rostelecom — YouTube',      region: 'Russia' },
    'ru_mts':            { label: 'MTS',                       region: 'Russia' },
    'ru_beeline':        { label: 'Beeline',                   region: 'Russia' },
    'ru_megafon':        { label: 'MegaFon',                   region: 'Russia' },
    'ru_yota':           { label: 'Yota',                      region: 'Russia' },
    'eu_uk_std':         { label: 'UK (BT/Virgin/Sky)',        region: 'Europe' },
    'eu_de_fr':          { label: 'Germany / France',          region: 'Europe' },
    'mid_iran':          { label: 'Iran (Heavy DPI)',          region: 'Middle East' },
    'mid_uae':           { label: 'UAE (Etisalat/du)',         region: 'Middle East' },
    'asia_in':           { label: 'India',                     region: 'Asia' },
    'asia_pk':           { label: 'Pakistan',                  region: 'Asia' }
};

// Wraps a profile's argv with global flags before spawn:
//   1. --wf-l3=ipv4,ipv6 prepended (IPv6 dual-stack)
//   2. --dpi-desync-fake-tls / -fake-quic flags stripped if the payload files
//      haven't been downloaded yet (otherwise winws.exe would refuse to start)
// Centralising this keeps the static profile list clean and lets new profiles
// inherit safe defaults automatically.
function applyGlobalProfileFlags(args) {
    let out = Array.isArray(args) ? args.slice() : [];

    // Strip fake payload flags if the bin files aren't on disk yet
    if (!fakePayloadsAvailable()) {
        out = out.filter(a =>
            typeof a !== 'string' ||
            (!a.startsWith('--dpi-desync-fake-tls=') && !a.startsWith('--dpi-desync-fake-quic='))
        );
    }

    // IPv6 dual-stack prepend
    const hasL3 = out.some(a => typeof a === 'string' && a.startsWith('--wf-l3='));
    if (!hasL3) out.unshift('--wf-l3=ipv4,ipv6');

    return out;
}

// Infer rich metadata for a profile by inspecting its zapret argv. This avoids
// hand-writing 50+ entries and stays correct when profiles are tuned later —
// the UI sees fresh info on every restart.
function inferProfileMeta(id) {
    const args = ZAPRET_PROFILES[id] || [];
    const argStr = args.join(' ');

    // Voice-ready iff there's a dedicated UDP 50000-65535 filter chain OR
    // any-protocol UDP fragmentation (the two patterns Discord voice needs).
    const voiceReady = argStr.includes('--filter-udp=50000-65535') ||
                       argStr.includes('--dpi-desync-any-protocol');

    // Uses fake-TLS or fake-QUIC payloads (depends on downloaded .bin files)
    const usesFakePayload = argStr.includes('--dpi-desync-fake-tls=') ||
                            argStr.includes('--dpi-desync-fake-quic=');

    // Counts chain segments separated by '--new'
    const chainCount = args.filter(a => a === '--new').length + (args.length > 0 ? 1 : 0);

    // Difficulty heuristic — id suffix + flag richness
    let difficulty = 'low';
    if (id.endsWith('_ultimate'))          difficulty = 'extreme';
    else if (id.endsWith('_pro'))          difficulty = 'high';
    else if (id.endsWith('_all_in_one'))   difficulty = 'medium';
    else if (id.endsWith('_fiber'))        difficulty = 'high';
    else if (chainCount >= 4)              difficulty = 'high';
    else if (chainCount >= 2)              difficulty = 'medium';

    // Vendor / family classification by id prefix
    let vendor = null;
    if (id.startsWith('tr_ttnet'))         vendor = 'Sandvine';
    else if (id.startsWith('tr_vodafone')) vendor = 'Sandvine';
    else if (id.startsWith('tr_superonline')) vendor = 'Allot';
    else if (id.startsWith('tr_mobile'))   vendor = 'Sandvine-Mobile';
    else if (id.startsWith('tr_'))         vendor = 'Light';
    else if (id.startsWith('ru_'))         vendor = 'TSPU';
    else if (id.startsWith('eu_'))         vendor = 'Light';
    else if (id.startsWith('mid_'))        vendor = 'Heavy';
    else if (id.startsWith('asia_'))       vendor = 'Mixed';

    // Coarse 'supports' tags — driven by argv content + id intent
    const supports = [];
    if (argStr.includes('--filter-udp=50000-65535')) supports.push('discord-voice');
    if (id.includes('discord'))                       supports.push('discord');
    if (id.includes('youtube') || id.includes('yt'))  supports.push('youtube');
    if (id.includes('discord') || id.endsWith('_ultimate') || id.endsWith('_pro') || id.endsWith('_all_in_one')) {
        if (!supports.includes('discord')) supports.push('discord');
    }
    // All-in-One / Ultimate / Pro implicitly cover the major targets
    if (id.endsWith('_ultimate') || id.endsWith('_pro') || id.endsWith('_all_in_one')) {
        ['youtube', 'x', 'twitch'].forEach(s => { if (!supports.includes(s)) supports.push(s); });
    }

    return { voiceReady, usesFakePayload, chainCount, difficulty, vendor, supports };
}

// Expose profile catalog to renderer for UI categorization
ipcMain.handle('get-dpi-profiles', () => {
    return Object.keys(PROFILE_META).map(id => {
        const base = PROFILE_META[id];
        const meta = inferProfileMeta(id);
        return {
            id,
            label: base.label,
            region: base.region,
            ...meta
        };
    });
});

// Raw argv of a built-in profile — used by the profile builder's "clone" so the
// user can start from a proven ruleset and tweak it. Returns a copy (or null).
ipcMain.handle('get-profile-args', (event, id) => {
    return Array.isArray(ZAPRET_PROFILES[id]) ? ZAPRET_PROFILES[id].slice() : null;
});

module.exports = { ZAPRET_PROFILES, PROFILE_META, applyGlobalProfileFlags, inferProfileMeta };
