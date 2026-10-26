#!/bin/bash
# Training recipes in dependency order. Run from guard_qlearning.
# Intermediate checkpoints referenced by init= must be trained or supplied first.
# Run the commands individually; this file documents the original recipes.
# Common prefix: PYTHONPATH=. OPENBLAS_NUM_THREADS=1 python3 -m guardrl.train --set out=runs/<name> threads=3 numba_threads=2 ...
T="python3 -m guardrl.train --set threads=3 numba_threads=2"
M2='plan=plans/2. Simple Centre.json'; M3='plan=plans/3. Two Chair Square.json'
# --- generalist pre-training on the 31 cold-start plans
python3 maps/generate_curriculum.py 24
python3 -m guardrl.train --config configs/gen_bdq.json --set out=runs/gen_bdq threads=3 numba_threads=2
# --- variants on Map 2 (one guard)
$T out=runs/A1_m2_bdq_const "$M2" steps=400000 w_level=0.3
$T out=runs/A2_m2_bdq_anneal "$M2" steps=400000 w_level=0.3 w_level_start=3.0
$T out=runs/A3_m2_flat_anneal "$M2" steps=400000 w_level=0.3 w_level_start=3.0 head=flat
$T out=runs/A4_m2_noisy_anneal "$M2" steps=400000 w_level=0.3 w_level_start=3.0 noisy=true
$T out=runs/A5_m2_demo_anneal "$M2" steps=400000 w_level=0.3 w_level_start=3.0 demo_steps=50000 demo_pretrain_updates=3000
$T out=runs/A7_m2_level_anneal "$M2" steps=400000 w_level=0.3 w_level_start=3.0 reward=level
python3 -m guardrl.tabular --steps 1000000 --w_level 0.3 --out runs/T1_m2_tab
python3 -m guardrl.tabular --steps 1000000 --w_level 0.3 --features --out runs/T2_m2_tabF
# --- weight sweep on Map 3
for w in 0.03 0.1 0.3 1.0 3.0; do $T out=runs/S_m3_w$w "$M3" steps=400000 w_level=$w w_level_start=$(python3 -c "print($w*10)"); done
# --- one guard per plan: scratch (P1), from generalist (P2), DQfD (P3), chair starts (P4)
$T out=runs/P1_m1_scratch 'plan=plans/1. Simple Corridor.json' steps=500000 w_level=0.3 w_level_start=3.0
$T out=runs/P1_m4_scratch 'plan=plans/4. Prison Block.json' steps=500000 w_level=0.3 w_level_start=3.0
$T out=runs/P1_m5_scratch 'plan=plans/5. Awkward Museum.json' steps=600000 w_level=0.3 w_level_start=3.0
$T out=runs/P1_m6_scratch 'plan=plans/6. The Courtyard.json' steps=600000 w_level=0.3 w_level_start=3.0
$T out=runs/P1_m7_scratch 'plan=plans/7. Alcatraz.json' steps=600000 w_level=0.3 w_level_start=3.0
for m in 1 2 3 4; do p=$(ls plans/$m.*.json); $T out=runs/P2_m${m}_gen "plan=$p" init=runs/gen_bdq/best.pt steps=400000 w_level=0.3 w_level_start=1.0 w_anneal_frac=0.3 eps_start=0.3 learn_start=20000; done
for m in 5 6 7; do p=$(ls plans/$m.*.json); $T out=runs/P3_m${m}_demo "plan=$p" steps=800000 w_level=0.3 eps_start=0.2 nstep=5 demo_steps=100000 demo_pretrain_updates=5000 demo_frac=0.15 learn_start=20000; done
$T out=runs/P4_m1_chairstart 'plan=plans/1. Simple Corridor.json' init=runs/P1_m1_scratch/best.pt steps=300000 w_level=0.3 eps_start=0.5 chair_start=0.5 learn_start=20000
# --- second guard on Map 3: transfer options
$T out=runs/D_m3_shared "$M3" n_guards=2 n_envs=16 init=runs/S_m3_w0.3/best.pt steps=600000 w_level=0.3 eps_start=0.5 learn_start=20000
$T out=runs/D_m3_separate "$M3" n_guards=2 n_envs=16 init=runs/S_m3_w0.3/best.pt n_nets=2 'net_of_guard=[0,1]' 'init_mapping=[0,0]' steps=600000 w_level=0.3 eps_start=0.5 learn_start=20000
$T out=runs/D_m3_naive2 "$M3" n_guards=2 n_envs=16 init=runs/S_m3_w0.3/best.pt n_nets=2 'net_of_guard=[0,1]' 'init_mapping=[0,-1]' steps=600000 w_level=0.3 eps_start=0.5 learn_start=20000
# --- two guards everywhere (init = best one-guard network of the plan at launch time, copied to runs/init_m<k>_g1.pt)
for m in 2 3 4 5 6 7; do p=$(ls plans/$m.*.json); $T out=runs/E2_m${m}_demo "plan=$p" n_guards=2 n_envs=16 init=runs/init_m${m}_g1.pt steps=600000 w_level=0.3 eps_start=0.2 nstep=5 demo_steps=100000 demo_pretrain_updates=3000 demo_frac=0.1 learn_start=20000; done
# --- three guards on Alcatraz
$T out=runs/E3_m7_demo 'plan=plans/7. Alcatraz.json' n_guards=3 n_envs=12 init=runs/init_m7_g2.pt steps=600000 w_level=0.3 eps_start=0.2 nstep=5 demo_steps=90000 demo_pretrain_updates=3000 demo_frac=0.1 learn_start=20000
