"""
Validate the physics for the Hellings & Downs cross-correlation demo.

Goal: confirm that the time-domain Pearson cross-correlation of two pulsars'
timing residuals, driven by N common stochastic GW sources scattered over the
sky, tracks the analytic Hellings & Downs (HD) overlap-reduction curve in the
large-N limit -- WITH the pulsar term giving the canonical 1/2 intercept.

Run:  python3 validate.py
"""
import numpy as np

rng = np.random.default_rng(7)

# ---------- analytic HD curve, normalised to 1/2 at zero separation ----------
def hd(gamma):
    x = (1.0 - np.cos(gamma)) / 2.0
    out = np.full_like(x, 0.5)
    m = x > 0
    out[m] = 0.5 + 1.5 * x[m] * np.log(x[m]) - 0.25 * x[m]
    return out

# ---------- antenna response ----------
def pol_basis(Omega, psi):
    """Return (eplus, ecross) polarization tensors for GW propagating along Omega."""
    Omega = Omega / np.linalg.norm(Omega)
    ref = np.array([0.0, 0.0, 1.0])
    if abs(np.dot(ref, Omega)) > 0.99:
        ref = np.array([0.0, 1.0, 0.0])
    m0 = ref - np.dot(ref, Omega) * Omega
    m0 /= np.linalg.norm(m0)
    n0 = np.cross(Omega, m0)
    c, s = np.cos(psi), np.sin(psi)
    m = c * m0 + s * n0
    n = -s * m0 + c * n0
    eplus = np.outer(m, m) - np.outer(n, n)
    ecross = np.outer(m, n) + np.outer(n, m)
    return eplus, ecross

def response(phat, Omega, eplus, ecross):
    """F+ , Fx  for pulsar phat, source GW propagating along Omega."""
    denom = 1.0 + np.dot(Omega, phat)
    if abs(denom) < 1e-6:
        denom = np.sign(denom) * 1e-6 if denom != 0 else 1e-6
    Fp = 0.5 * (phat @ eplus @ phat) / denom
    Fc = 0.5 * (phat @ ecross @ phat) / denom
    return Fp, Fc

def rand_sky(n):
    z = rng.uniform(-1, 1, n)
    phi = rng.uniform(0, 2 * np.pi, n)
    r = np.sqrt(1 - z * z)
    return np.stack([r * np.cos(phi), r * np.sin(phi), z], axis=1)

# ---------- experiment 1: expected mu(gamma)/(2 mu(0)) over many sources ------
def mu_ratio(gamma, Nsrc=4000):
    pa = np.array([0.0, 0.0, 1.0])
    pb = np.array([np.sin(gamma), 0.0, np.cos(gamma)])
    dirs = rand_sky(Nsrc)
    psis = rng.uniform(0, np.pi, Nsrc)
    num = 0.0   # Earth-Earth cross  (correlated)
    da = 0.0    # pulsar a auto (Earth)
    for k in range(Nsrc):
        ep, ec = pol_basis(dirs[k], psis[k])
        Fap, Fac = response(pa, dirs[k], ep, ec)
        Fbp, Fbc = response(pb, dirs[k], ep, ec)
        num += Fap * Fbp + Fac * Fbc
        da += Fap * Fap + Fac * Fac
    # auto includes Earth+pulsar term => 2*da ; cross is Earth-Earth only
    return num / (2.0 * da)

print("=== Expected correlation ratio vs analytic HD ===")
print(f"{'gamma(deg)':>10} {'sim mu/2mu0':>12} {'HD(gamma)':>10}")
for g in [1, 30, 60, 90, 120, 150, 179]:
    gr = np.radians(g)
    sim = mu_ratio(gr)
    an = hd(np.array([gr]))[0]
    print(f"{g:>10} {sim:>12.4f} {an:>10.4f}")

# ---------- experiment 2: full time-series Pearson correlation ----------------
print("\n=== Time-domain Pearson cross-correlation (pulsar term ON) ===")
print(f"{'gamma(deg)':>10} {'pearson':>10} {'HD(gamma)':>10}")

def residual_pair(gamma, Nsrc, Tn=400, Kmodes=6):
    pa = np.array([0.0, 0.0, 1.0])
    pb = np.array([np.sin(gamma), 0.0, np.cos(gamma)])
    t = np.linspace(0, 1, Tn)
    freqs = np.arange(1, Kmodes + 1) * 2.0  # arbitrary band
    ra = np.zeros(Tn); rb = np.zeros(Tn)
    dirs = rand_sky(Nsrc)
    psis = rng.uniform(0, np.pi, Nsrc)
    for k in range(Nsrc):
        ep, ec = pol_basis(dirs[k], psis[k])
        Fap, Fac = response(pa, dirs[k], ep, ec)
        Fbp, Fbc = response(pb, dirs[k], ep, ec)
        # Earth term: common waveform for + and x
        hp = np.zeros(Tn); hx = np.zeros(Tn)
        for f in freqs:
            hp += rng.normal() * np.cos(2*np.pi*f*t + rng.uniform(0, 2*np.pi))
            hx += rng.normal() * np.cos(2*np.pi*f*t + rng.uniform(0, 2*np.pi))
        # pulsar terms: independent per pulsar
        hpa = np.zeros(Tn); hxa = np.zeros(Tn)
        hpb = np.zeros(Tn); hxb = np.zeros(Tn)
        for f in freqs:
            hpa += rng.normal() * np.cos(2*np.pi*f*t + rng.uniform(0, 2*np.pi))
            hxa += rng.normal() * np.cos(2*np.pi*f*t + rng.uniform(0, 2*np.pi))
            hpb += rng.normal() * np.cos(2*np.pi*f*t + rng.uniform(0, 2*np.pi))
            hxb += rng.normal() * np.cos(2*np.pi*f*t + rng.uniform(0, 2*np.pi))
        ra += Fap * (hp - hpa) + Fac * (hx - hxa)
        rb += Fbp * (hp - hpb) + Fbc * (hx - hxb)
    ra -= ra.mean(); rb -= rb.mean()
    return ra, rb

for g in [1, 30, 60, 90, 120, 150, 179]:
    gr = np.radians(g)
    # average pearson over several realisations to expose the mean
    vals = []
    for _ in range(40):
        ra, rb = residual_pair(gr, Nsrc=300)
        vals.append(np.dot(ra, rb) / np.sqrt(np.dot(ra, ra) * np.dot(rb, rb)))
    an = hd(np.array([gr]))[0]
    print(f"{g:>10} {np.mean(vals):>10.4f} {an:>10.4f}")
