#!/usr/bin/env python3
"""
Physics validation for the "Pulse Delays Along the Geodesic" demo.

Mirrors the constants/functions in index.html and checks the claims the demo
rests on:

  1. The antenna response F^A = (1/2) p^i p^j e^A_ij / (1+mu) computed by the
     explicit tensor contraction equals the (pm^2-pn^2)/2/(1+mu) shorthand used
     in the JS.
  2. The endpoint-collapse identity: the redshift, which the derivation writes
     as a *line integral of the metric perturbation along the photon geodesic*,
        z = -1/2 p^i p^j  ∫_{t_p}^{t_e} ∂_t h_ij(t, x(t)) dt,
     numerically equals the closed two-endpoint form
        z = F^A [ h_A(xi_e) - h_A(xi_p) ]
     (up to the overall sign convention of z), with
        xi_e = t_e,  xi_p = t_e - L(1+mu).
  3. The timing residual closed form R(t)=∫_0^t z dt' matches direct numeric
     integration, and lands on the expected ~nanosecond scale.

Run:  python3 validate.py
"""
import numpy as np

# ---- constants (match index.html) ----
NHZ    = 1e-9
YR     = 3.15576e7          # s / yr
KPC_LY = 3261.564           # light-years per kpc  (== kpc expressed in light-yr)
RES_TO_NS = 1e-15 * YR * 1e9

PHI_P, PHI_C = 0.0, np.pi/2

def omega_yr(f_nHz):            # 2*pi*f  in rad/yr
    return 2*np.pi*f_nHz*NHZ*YR

def lag_yr(Lkpc, mu):          # tau = L(1+mu) in years (L in light-years)
    return Lkpc*KPC_LY*(1+mu)

def basis(Omega, psi):
    ref = np.array([0,1.,0])
    if abs(ref@Omega) > 0.95: ref = np.array([1.,0,0])
    m0 = ref - (ref@Omega)*Omega; m0 /= np.linalg.norm(m0)
    n0 = np.cross(Omega, m0);     n0 /= np.linalg.norm(n0)
    c,s = np.cos(psi), np.sin(psi)
    m =  c*m0 + s*n0
    n = -s*m0 + c*n0
    return m, n

def pol_tensors(m, n):
    ep = np.outer(m,m) - np.outer(n,n)      # e^+_ij
    ec = np.outer(m,n) + np.outer(n,m)      # e^x_ij
    return ep, ec

def strain_amps(h0_15, mode):
    if mode=='+':  return h0_15, 0.0
    if mode=='x':  return 0.0, h0_15
    return h0_15/np.sqrt(2), h0_15/np.sqrt(2)

# ---------------------------------------------------------------- checks
def check_responses():
    rng = np.random.default_rng(0)
    worst = 0.0
    for _ in range(2000):
        p = rng.normal(size=3); p/=np.linalg.norm(p)
        Om= rng.normal(size=3); Om/=np.linalg.norm(Om)
        mu = Om@p
        if abs(1+mu) < 1e-2: continue
        psi = rng.uniform(0,np.pi)
        m,n = basis(Om,psi); ep,ec = pol_tensors(m,n)
        # explicit contraction
        Fp_t = 0.5*(p@ep@p)/(1+mu)
        Fc_t = 0.5*(p@ec@p)/(1+mu)
        # JS shorthand
        pm,pn = p@m, p@n
        Fp_s = 0.5*(pm*pm-pn*pn)/(1+mu)
        Fc_s = (pm*pn)/(1+mu)
        worst = max(worst, abs(Fp_t-Fp_s), abs(Fc_t-Fc_s))
    print(f"[1] F+/Fx tensor vs shorthand : max diff {worst:.2e}", "OK" if worst<1e-9 else "FAIL")
    return worst<1e-9

def check_endpoint_collapse():
    """Line integral along the geodesic == two-endpoint form."""
    f_nHz, h0_15, Lkpc, psi = 12.0, 2.0, 1.0, 0.4
    w = omega_yr(f_nHz)
    Ap, Ac = strain_amps(h0_15, 'both')
    p  = np.array([0.15,0.32,1.0]); p/=np.linalg.norm(p)
    th = np.deg2rad(63.0)
    # build Omega at angle th from p
    e1 = np.array([0,1.,0]) - (np.array([0,1.,0])@p)*p; e1/=np.linalg.norm(e1)
    e2 = np.cross(p,e1)
    Omega = np.cos(th)*p + np.sin(th)*e1
    mu = Omega@p
    m,n = basis(Omega,psi); ep,ec = pol_tensors(m,n)

    def hplus(xi):  return Ap*np.sin(w*xi+PHI_P)
    def hcross(xi): return Ac*np.sin(w*xi+PHI_C)

    t_e = 7.3                          # reception time (yr)
    L_yr = Lkpc*KPC_LY                 # light-travel time of the photon (yr)
    tau  = lag_yr(Lkpc, mu)            # PHASE lag L(1+mu) (yr) — not the travel time
    t_p  = t_e - L_yr                  # emission time: pure light travel

    # --- LINE INTEGRAL FORM ---------------------------------------------------
    # photon path x(t') = p * (t_e - t')  (distance from Earth, light-years).
    # partial time-derivative of the plane wave at fixed x: ∂_t h_A = h_A'(t'-Om.x)
    tt = np.linspace(t_p, t_e, 600001)
    x  = np.outer(t_e - tt, p)                       # (N,3)
    phi= tt - x@Omega                                # plane-wave phase along path
    dt_hplus  = Ap*w*np.cos(w*phi+PHI_P)
    dt_hcross = Ac*w*np.cos(w*phi+PHI_C)
    trapz = getattr(np, 'trapezoid', getattr(np, 'trapz', None))
    Ip = trapz(dt_hplus,  tt)
    Ic = trapz(dt_hcross, tt)
    z_line = -0.5*(p@ep@p)*Ip - 0.5*(p@ec@p)*Ic      # -1/2 p^i p^j ∫ ∂_t h_ij dt

    # --- TWO-ENDPOINT FORM (as coded in the demo, up to sign of z) -----------
    Fp = 0.5*(p@ep@p)/(1+mu)
    Fc = 0.5*(p@ec@p)/(1+mu)
    xi_e, xi_p = t_e, t_e - tau
    z_end = Fp*(hplus(xi_e)-hplus(xi_p)) + Fc*(hcross(xi_e)-hcross(xi_p))

    # the line integral equals -z_end (sign convention); compare magnitudes
    rel = abs(z_line + z_end)/max(1e-30, abs(z_end))
    print(f"[2] line-integral z = {z_line:+.6e}   endpoint z = {z_end:+.6e}")
    print(f"    geodesic integral collapses to endpoints : rel resid {rel:.2e}",
          "OK" if rel<1e-4 else "FAIL")
    return rel<1e-4

def check_residual_and_scale():
    f_nHz, h0_15, Lkpc, psi = 12.0, 2.0, 1.0, 0.0
    w = omega_yr(f_nHz)
    Ap, Ac = strain_amps(h0_15, 'both')
    p = np.array([0.15,0.32,1.0]); p/=np.linalg.norm(p)
    th = np.deg2rad(60.0)
    e1 = np.array([0,1.,0]) - (np.array([0,1.,0])@p)*p; e1/=np.linalg.norm(e1)
    Omega = np.cos(th)*p + np.sin(th)*e1
    mu = Omega@p
    m,n = basis(Omega,psi); ep,ec = pol_tensors(m,n)
    Fp = 0.5*(p@ep@p)/(1+mu); Fc = 0.5*(p@ec@p)/(1+mu)
    tau = lag_yr(Lkpc, mu)
    def hplus(xi):  return Ap*np.sin(w*xi+PHI_P)
    def hcross(xi): return Ac*np.sin(w*xi+PHI_C)
    def z(t): return (Fp*(hplus(t)-hplus(t-tau)) + Fc*(hcross(t)-hcross(t-tau)))
    # closed form residual (matches JS): R = F * [ I(Ap,phi,0) - I(Ap,phi,tau) ] ...
    def I(amp,phi,shift,t): return amp*(np.cos(w*(0-shift)+phi)-np.cos(w*(t-shift)+phi))/w
    def R_closed(t):
        return ( Fp*I(Ap,PHI_P,0,t)+Fc*I(Ac,PHI_C,0,t)
               -(Fp*I(Ap,PHI_P,tau,t)+Fc*I(Ac,PHI_C,tau,t)) )
    ts = np.linspace(0,40,4001)
    # numeric cumulative integral of z
    R_num = np.concatenate([[0],np.cumsum((z(ts[1:])+z(ts[:-1]))/2*np.diff(ts))])
    R_cl  = np.array([R_closed(t) for t in ts])
    err = np.max(np.abs(R_num-R_cl))/max(1e-30,np.max(np.abs(R_cl)))
    print(f"[3] residual closed-form vs numeric ∫z : rel err {err:.2e}",
          "OK" if err<1e-3 else "FAIL")
    peak_ns = np.max(np.abs(R_cl))*RES_TO_NS
    print(f"    peak residual ~ {peak_ns:.2f} ns  (h0={h0_15}e-15, f={f_nHz} nHz)")
    sane = 0.05 < peak_ns < 500
    print("    nanosecond-scale sanity :", "OK" if sane else "FAIL")
    print(f"    pulsar-term lag tau ~ {tau:.0f} yr ({tau/1000:.2f} kyr)")
    return err<1e-3 and sane

if __name__=='__main__':
    ok = all([check_responses(), check_endpoint_collapse(), check_residual_and_scale()])
    print("\nALL CHECKS PASSED" if ok else "\nSOME CHECKS FAILED")
    raise SystemExit(0 if ok else 1)
