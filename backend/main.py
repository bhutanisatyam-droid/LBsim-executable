"""
=============================================================================
 LBSim - Backend Server  (backend/main.py)
=============================================================================
 This file IS the entire backend of the application.
 It runs a lightweight web server using FastAPI that:
   1. Receives inputs (Tx power, wavelength, distance, etc.) from the browser UI
   2. Performs all optical link-budget calculations in Python
   3. Sends the results back to the browser as JSON
   4. Also generates PDF reports and saves/loads calculations to disk

 How it fits in the project:
   - desktop_launcher.py  →  starts this server, then opens the browser window
   - frontend/            →  the HTML/JS/CSS that the user actually sees and clicks
   - backend/main.py      →  (THIS FILE) does all the maths and file work
=============================================================================
"""

# =============================================================================
#  IMPORTS
# =============================================================================

# --- FastAPI: the web-framework that powers our server ---
# FastAPI lets us define "routes" (URL endpoints) with simple Python functions.
# When the browser visits a URL like /api/calculate, FastAPI calls the matching
# function and automatically converts its return value to JSON.

from fastapi import FastAPI, HTTPException, Body
#   FastAPI     → the main class used to create our server app
#   HTTPException → used to send error responses (e.g. "400 Bad Request")
#   Body        → (imported but used implicitly by FastAPI for request parsing)

from fastapi.middleware.cors import CORSMiddleware
#   Middleware sits between every incoming request and our code.
#   CORS (Cross-Origin Resource Sharing) is a browser security rule that
#   normally blocks a web page from talking to a different server.
#   Since our HTML file and our Python server are technically "different origins",
#   we must explicitly allow them to communicate with each other.

from fastapi.responses import FileResponse, JSONResponse
#   FileResponse  → lets us send a file (e.g. a PDF) as the HTTP response
#   JSONResponse  → lets us send a custom JSON response (mostly used internally)

from fastapi.staticfiles import StaticFiles
#   StaticFiles → tells FastAPI to serve an entire folder of files (HTML/CSS/JS)
#   directly over HTTP, like a basic file server.

from pydantic import BaseModel, Field
#   Pydantic is a data-validation library that FastAPI uses heavily.
#   BaseModel → we inherit from this to define our request/response data shapes.
#   Field     → lets us attach rules to each field (e.g. "must be > 0", "required")
#   When a request arrives, Pydantic automatically checks that all the data
#   matches the declared types and rules before our code even runs.

from typing import Optional, Dict, Any
#   Python's built-in type-hint helpers (used in Pydantic model definitions):
#   Optional[X]  → the field may be X or None (i.e. it's not required)
#   Dict[K, V]   → a dictionary with keys of type K and values of type V
#   Any          → any Python type is allowed

import uvicorn
#   Uvicorn is the ASGI server that actually listens for HTTP connections.
#   Think of FastAPI as the traffic director and uvicorn as the actual road.
#   At the bottom of this file, uvicorn.run() starts everything.

from datetime import datetime
#   Standard Python library for getting the current date/time.
#   Used when stamping saved files and PDF reports.

import json
#   Standard Python library for reading/writing JSON files.
#   JSON is the text format used to save calculations to disk.

import os
#   Standard Python library for interacting with the operating system:
#   - building file paths  (os.path.join)
#   - checking if a file exists  (os.path.exists)
#   - listing directory contents  (os.listdir)
#   - creating directories  (os.makedirs)
#   - deleting files  (os.remove)

import math
#   Standard Python library for mathematical operations:
#   math.pi, math.log10, math.exp, math.degrees — all used in our physics formulas.

import tempfile
#   Standard library for creating temporary files/directories.
#   Not actively used in the current code but kept for compatibility.

import base64
#   Standard library for base64 encoding/decoding.
#   The browser sends the chart image as a base64-encoded string (text form of
#   binary image data), and we decode it here to embed it in the PDF.

import io
#   Standard library for working with in-memory byte streams.
#   We build the PDF in memory (io.BytesIO) before writing it to disk,
#   so we never create a partial file if something goes wrong.

from fastapi.responses import StreamingResponse
#   Lets us stream large data (like a file) back to the browser chunk-by-chunk.
#   Imported for completeness; not actively used in the current code flow.

# --- ReportLab: the PDF generation library ---
# ReportLab builds PDFs programmatically in Python.
# We use it to create the "Export PDF" report from the calculation results.

from reportlab.lib import colors
#   Provides named colors (colors.black, colors.grey) and hex color support.

from reportlab.lib.pagesizes import letter, landscape
#   letter    → standard US Letter page size (8.5 × 11 inches), used for our PDFs
#   landscape → landscape orientation (wider than tall); imported but not used here

from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, Image
#   "Platypus" is ReportLab's high-level layout engine (think Word-like layout):
#   SimpleDocTemplate → creates a document with auto page-breaks and margins
#   Table / TableStyle → builds data tables with custom colors and borders
#   Paragraph         → a block of formatted text
#   Spacer            → blank vertical space between elements
#   Image             → embeds an image (our chart screenshot) into the PDF

from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
#   getSampleStyleSheet → returns a set of pre-defined text styles (Heading1, Normal, etc.)
#   ParagraphStyle      → lets us create a custom text style (font, size, color, alignment)

from reportlab.lib.units import inch
#   Converts inches to ReportLab's internal unit (points).
#   e.g. 3*inch = 3 inches wide for a table column.


# =============================================================================
#  APP INITIALISATION
# =============================================================================

# Create the FastAPI application instance.
# The title/description/version appear in the auto-generated docs at /docs.
app = FastAPI(
    title="Optical Link Budget Calculator API",
    description="Calculate optical communication link budgets with detailed analysis",
    version="2.0.0"
)

# Allow the browser (frontend) to talk to this server without CORS errors.
# allow_origins=["*"] means ANY origin is allowed — fine for a local desktop app.
# allow_methods=["*"] means GET, POST, DELETE, etc. are all permitted.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# =============================================================================
#  STORAGE DIRECTORY
# =============================================================================

import pathlib

# Build a path to the user's Documents folder → "Documents/OpticalLinkCalculations"
# pathlib.Path.home() returns something like C:\Users\YourName on Windows.
# We save calculations and PDFs here so they survive even if the app is reinstalled.
docs_dir = os.path.join(pathlib.Path.home(), "Documents", "OpticalLinkCalculations")
STORAGE_DIR = docs_dir

# Create the folder if it doesn't already exist (exist_ok=True means no error if it does).
os.makedirs(STORAGE_DIR, exist_ok=True)


# =============================================================================
#  UNIT CONVERSION HELPERS
# =============================================================================
# These are simple math functions that convert between common power/signal units.
# The API always works in SI units internally (Watts, metres, etc.),
# so every user-entered value is converted before calculations run.

PI = math.pi  # 3.14159… — used in antenna gain and FSPL formulas below

def dbm_to_mw(dbm):
    """Convert power from dBm to milliwatts.  Formula: P_mW = 10^(dBm/10)"""
    return 10 ** (dbm / 10)

def mw_to_dbm(mw):
    """Convert power from milliwatts to dBm.  Formula: dBm = 10 * log10(mW)"""
    if mw <= 0:
        raise ValueError("Power must be positive")
    return 10 * math.log10(mw)

def dbm_to_w(dbm):
    """Convert dBm → Watts (via milliwatts, since 1 W = 1000 mW)."""
    return dbm_to_mw(dbm) / 1000

def w_to_dbm(watts):
    """Convert Watts → dBm (multiplies by 1000 first to get mW)."""
    return mw_to_dbm(watts * 1000)

def linear_to_db(linear_value):
    """Convert a linear (ratio) value to decibels.  Formula: dB = 10 * log10(ratio)
    e.g. antenna gain as a pure number → antenna gain in dB."""
    if linear_value <= 0:
        raise ValueError("Linear value must be positive")
    return 10 * math.log10(linear_value)


# =============================================================================
#  PRETTY-LABEL HELPER  (used only for PDF formatting)
# =============================================================================

def get_pretty_label(key: str) -> str:
    """
    Converts a raw internal key name like 'tx_power_dbm'
    into a human-readable label like 'Tx Power (dBm)' for PDF tables.

    First checks a manual lookup dictionary; if not found, applies
    automatic formatting rules (replace underscores, capitalise, fix units).
    """
    # Manual lookup dictionary: key → display label
    mapping = {
        "tx_power_dbm": "Tx Power (dBm)",
        "tx_power_mw": "Tx Power (mW)",
        "tx_efficiency": "Tx Efficiency (dec)",
        "tx_efficiency_percent": "Tx Efficiency (%)",
        "rx_efficiency": "Rx Efficiency (dec)",
        "rx_efficiency_percent": "Rx Efficiency (%)",
        "rx_sensitivity_dbm": "Rx Sensitivity (dBm)",
        "rx_sensitivity_mw": "Rx Sensitivity (mW)",
        "rx_lna_gain_db": "Rx LNA Gain (dB)",
        "wavelength_m": "Wavelength (m)",
        "wavelength_nm": "Wavelength (nm)",
        "tx_diameter_m": "Tx Diameter (m)",
        "rx_diameter_m": "Rx Diameter (m)",
        "distance_m": "Distance (m)",
        "distance_km": "Distance (km)",
        "implementation_loss_db": "Implementation Loss (dB)",
        "impl_loss_db": "Implementation Loss (dB)",
        "coupling_loss_db": "Coupling Loss (dB)",
        "tx_pointing_error_rad": "Tx Pointing Error (rad)",
        "rx_pointing_error_rad": "Rx Pointing Error (rad)",
        "tx_pointing_loss_db": "Tx Pointing Loss (dB)",
        "rx_pointing_loss_db": "Rx Pointing Loss (dB)",
        "tx_gain_db": "Tx Gain (dB)",
        "tx_gain_absolute": "Tx Gain (Absolute)",
        "rx_gain_db": "Rx Gain (dB)",
        "rx_gain_absolute": "Rx Gain (Absolute)",
        "tx_beam_divergence_rad": "Tx Beam Divergence (rad)",
        "tx_beam_divergence_deg": "Tx Beam Divergence (deg)",
        "rx_beam_divergence_rad": "Rx Beam Divergence (rad)",
        "rx_beam_divergence_deg": "Rx Beam Divergence (deg)",
        "path_loss_db": "Path Loss (dB)",
        "total_loss_db": "Total Loss (dB)",
        "received_power_dbm": "Received Power (dBm)",
        "received_power_mw": "Received Power (mW)",
        "received_power_w": "Received Power (W)",
        "received_power_lna_dbm": "Received Power LNA (dBm)",
        "received_power_lna_mw": "Received Power LNA (mW)",
        "received_power_lna_w": "Received Power LNA (W)",
        "link_margin_db": "Link Margin (dB)",
        "link_viable": "Link Viable"
    }
    if key in mapping:
        return mapping[key]

    # Fallback: if the key isn't in our manual list, auto-format it.
    # e.g. "some_new_value_dbm" → "Some New Value (dBm)"
    name = key.replace('_', ' ').title()
    suffixes = {
        " Dbm": " (dBm)",
        " Mw": " (mW)",
        " Db": " (dB)",
        " Nm": " (nm)",
        " Rad": " (rad)",
        " Deg": " (deg)",
        " Percent": " (%)",
        " Km": " (km)",
        " M": " (m)",
        " W": " (W)"
    }
    for suffix, unit in suffixes.items():
        if name.endswith(suffix):
            # Chop off the raw suffix and add the formatted unit instead
            name = name[:-len(suffix)] + unit
            break
    return name


# =============================================================================
#  PHYSICS / OPTICS CALCULATION FUNCTIONS
# =============================================================================

def calculate_beam_divergence(wavelength_m, diameter_m):
    """
    Rayleigh criterion for beam divergence (full angle, in radians).
    Formula: θ = 2.44 × (λ / D)
      λ = wavelength in metres
      D = aperture diameter in metres
    A larger aperture = smaller divergence = tighter beam.
    """
    return 2.44 * (wavelength_m / diameter_m)


def calculate_antenna_gain(efficiency, wavelength_m, diameter_m):
    """
    Aperture antenna gain (same formula for Tx and Rx optical telescopes).
    Formula: G = (π × D / λ)²
    Returns both the absolute (linear) gain and its dB equivalent.
    Efficiency is already factored in separately via efficiency_loss later.
    """
    gain_abs = ((PI * diameter_m / wavelength_m) ** 2)
    gain_db  = linear_to_db(gain_abs)
    return gain_db, gain_abs


def calculate_free_space_path_loss(distance_m, wavelength_m):
    """
    Free-Space Path Loss (FSPL) — the signal power lost simply due to
    the beam spreading out over distance in open space (no absorption).
    Formula: FSPL = (4π × d / λ)²   (linear), then converted to dB.
    This is the dominant loss term in optical links.
    """
    fspl    = ((4 * PI * distance_m) / wavelength_m) ** 2
    fspl_db = linear_to_db(fspl)
    return fspl_db


def validate_inputs(params):
    """
    Checks that all required fields are present and physically sensible
    before we do any maths.  Returns (True, None) if all is fine,
    or (False, "error message") if something is wrong.
    This prevents crashes from invalid input (negative distance, etc.).
    """
    errors = []

    # List of fields that MUST be present — cannot be None or missing
    required = ['tx_power_dbm', 'tx_efficiency', 'rx_efficiency',
                 'wavelength_m', 'tx_diameter_m', 'rx_diameter_m', 'distance_m']
    for field in required:
        if field not in params:
            errors.append(f"Missing required field: {field}")
    if errors:
        return False, "; ".join(errors)  # return early if fields are missing

    # Range checks — these must be physically valid values
    if not (0 < params['tx_efficiency'] <= 1):
        errors.append("TX efficiency must be between 0 and 1")
    if not (0 < params['rx_efficiency'] <= 1):
        errors.append("RX efficiency must be between 0 and 1")
    if params['wavelength_m'] <= 0:
        errors.append("Wavelength must be positive")
    if params['tx_diameter_m'] <= 0:
        errors.append("TX diameter must be positive")
    if params['rx_diameter_m'] <= 0:
        errors.append("RX diameter must be positive")
    if params['distance_m'] <= 0:
        errors.append("Distance must be positive")
    if params.get('rx_lna_gain_db', 0) < 0:
        errors.append("Rx LNA gain must be 0 or positive")

    if errors:
        return False, "; ".join(errors)
    return True, None  # all good


def calculate_pointing_loss(gain_abs, error_rad):
    """
    Pointing loss in dB due to a beam misalignment angle (error_rad).
    Uses the Gaussian beam approximation:
        Loss_linear = exp(-G × θ²)
        Loss_dB     = |10 × log10(Loss_linear)|

    Where G is the absolute antenna gain and θ is the pointing error in radians.
    A larger gain (tighter beam) makes you more sensitive to pointing errors.

    The exponent clamp at -700 prevents a Python math overflow error
    (math.exp of a very large negative number would crash).
    """
    if not error_rad or error_rad <= 0:
        return 0.0  # no pointing error → no loss

    exponent = -gain_abs * (error_rad ** 2)

    # Safe fallback for extreme pointing error to prevent math range error
    if exponent < -700:
        return 1000.0  # effectively infinite loss (beam completely off-target)

    loss_linear = math.exp(exponent)

    if loss_linear <= 0:
         return 1000.0

    loss_db = 10 * math.log10(loss_linear)
    return abs(loss_db)  # always return a positive dB loss value


def calculate_link_budget(params):
    """
    The core link-budget calculation engine.
    Takes a dictionary of all input parameters (in SI units) and returns
    a nested dictionary with every intermediate and final result.

    The link-budget equation being computed is:
      P_rx = P_tx + G_tx + G_rx - L_path - L_impl - L_coupling
             - L_tx_pointing - L_rx_pointing - L_tx_eff - L_rx_eff
      Link Margin = P_rx (after LNA) - Rx_sensitivity
    """

    # --- Unpack all inputs from the params dictionary ---
    p_tx_dbm             = params['tx_power_dbm']
    tx_efficiency        = params['tx_efficiency']
    rx_efficiency        = params['rx_efficiency']
    wavelength_m         = params['wavelength_m']
    tx_diameter_m        = params['tx_diameter_m']
    rx_diameter_m        = params['rx_diameter_m']
    distance_m           = params['distance_m']
    impl_loss_db         = params.get('implementation_loss_db', 0)   # default 0 if not provided
    coupling_loss_db     = params.get('coupling_loss_db', 0)
    tx_pointing_loss_db  = params.get('tx_pointing_loss_db', 0)
    rx_pointing_loss_db  = params.get('rx_pointing_loss_db', 0)
    tx_pointing_error_rad= params.get('tx_pointing_error_rad', None)  # None = not provided
    rx_pointing_error_rad= params.get('rx_pointing_error_rad', None)
    p_rx_sensitivity_dbm = params.get('rx_sensitivity_dbm', None)
    rx_lna_gain_db       = params.get('rx_lna_gain_db', 0)

    # --- Step 1: Beam divergence (full angle in radians) ---
    tx_theta = calculate_beam_divergence(wavelength_m, tx_diameter_m)
    rx_theta = calculate_beam_divergence(wavelength_m, rx_diameter_m)

    # --- Step 2: Antenna gains (dB and linear) ---
    g_tx_db, g_tx_abs = calculate_antenna_gain(tx_efficiency, wavelength_m, tx_diameter_m)
    g_rx_db, g_rx_abs = calculate_antenna_gain(rx_efficiency, wavelength_m, rx_diameter_m)

    # --- Step 3: Pointing losses (overwrite if error angle was provided) ---
    # The user can either provide a pointing error angle (rad) OR a direct loss value (dB).
    # If they provide an angle, we calculate the loss from it here.
    if tx_pointing_error_rad and tx_pointing_error_rad > 0:
        tx_pointing_loss_db = calculate_pointing_loss(g_tx_abs, tx_pointing_error_rad)

    if rx_pointing_error_rad and rx_pointing_error_rad > 0:
        rx_pointing_loss_db = calculate_pointing_loss(g_rx_abs, rx_pointing_error_rad)

    # --- Step 4: Free-Space Path Loss ---
    path_loss_db = calculate_free_space_path_loss(distance_m, wavelength_m)

    # --- Step 5: Total loss (sum of all loss terms) ---
    total_loss_db = (path_loss_db + impl_loss_db + coupling_loss_db +
                     tx_pointing_loss_db + rx_pointing_loss_db)

    # Efficiency loss: how much power is lost because efficiency < 100%
    # e.g. 50% efficiency = -3 dB loss
    tx_efficiency_loss_db = abs(10 * math.log10(tx_efficiency)) if tx_efficiency > 0 else 1000.0
    rx_efficiency_loss_db = abs(10 * math.log10(rx_efficiency)) if rx_efficiency > 0 else 1000.0

    # --- Step 6: Received power (before LNA) ---
    # Full link-budget equation in dB arithmetic:
    rcvd_power_dbm = p_tx_dbm + g_tx_db + g_rx_db - total_loss_db - tx_efficiency_loss_db - rx_efficiency_loss_db
    rcvd_power_mw  = dbm_to_mw(rcvd_power_dbm)
    rcvd_power_w   = dbm_to_w(rcvd_power_dbm)

    # --- Step 7: Apply LNA gain ---
    # LNA (Low Noise Amplifier) boosts the received optical signal.
    # In dB: adding gain is just adding the dB value.
    rcvd_power_lna_dbm = rcvd_power_dbm + rx_lna_gain_db
    rcvd_power_lna_mw  = dbm_to_mw(rcvd_power_lna_dbm)
    rcvd_power_lna_w   = dbm_to_w(rcvd_power_lna_dbm)

    # --- Step 8: Link Margin ---
    # Link Margin = (received power after LNA) - (minimum sensitivity of receiver)
    # Positive margin → link works.  Negative → link fails.
    link_margin_db = None  # stays None if no sensitivity was provided
    if p_rx_sensitivity_dbm is not None:
        link_margin_db = rcvd_power_lna_dbm - p_rx_sensitivity_dbm

    # --- Return all results as a structured nested dictionary ---
    return {
        'inputs': {
            'tx_power_dbm':          p_tx_dbm,
            'tx_power_mw':           dbm_to_mw(p_tx_dbm),
            'tx_efficiency_percent': tx_efficiency * 100,
            'rx_efficiency_percent': rx_efficiency * 100,
            'wavelength_nm':         wavelength_m * 1e9,      # m → nm (×1e9)
            'wavelength_m':          wavelength_m,
            'tx_diameter_m':         tx_diameter_m,
            'rx_diameter_m':         rx_diameter_m,
            'distance_m':            distance_m,
            'distance_km':           distance_m / 1000,
            'rx_sensitivity_dbm':    p_rx_sensitivity_dbm,
            'rx_lna_gain_db':        rx_lna_gain_db,
        },
        'antenna_gains': {
            'tx_gain_db':  g_tx_db,
            'tx_gain_abs': g_tx_abs,
            'rx_gain_db':  g_rx_db,
            'rx_gain_abs': g_rx_abs,
        },
        'beam_divergence': {
            'tx_theta_rad': tx_theta,
            'tx_theta_deg': math.degrees(tx_theta),   # convert rad → degrees for display
            'rx_theta_rad': rx_theta,
            'rx_theta_deg': math.degrees(rx_theta),
        },
        'losses': {
            'path_loss_db':           path_loss_db,
            'implementation_loss_db': impl_loss_db,
            'coupling_loss_db':       coupling_loss_db,
            'tx_pointing_loss_db':    tx_pointing_loss_db,
            'rx_pointing_loss_db':    rx_pointing_loss_db,
            'tx_efficiency_loss_db':  tx_efficiency_loss_db,
            'rx_efficiency_loss_db':  rx_efficiency_loss_db,
            'total_loss_db':          total_loss_db,
        },
        'received_power': {
            'power_dbm': rcvd_power_dbm,
            'power_mw':  rcvd_power_mw,
            'power_w':   rcvd_power_w,
        },
        'received_power_with_lna': {
            'power_dbm': rcvd_power_lna_dbm,
            'power_mw':  rcvd_power_lna_mw,
            'power_w':   rcvd_power_lna_w,
        },
        'link_margin': {
            'margin_db':        link_margin_db,
            'margin_available': link_margin_db is not None,         # bool: was sensitivity provided?
            'link_viable':      link_margin_db > 0 if link_margin_db is not None else None,
        },
    }


def flatten_results(raw: dict) -> dict:
    """
    The calculate_link_budget() function returns a deeply nested dict
    (inputs → antenna_gains → losses → …).  The frontend JS expects a
    single flat dictionary where every result is at the top level.

    This function unpacks all the nested values into one flat dict.
    e.g. raw['antenna_gains']['tx_gain_db']  →  flat['tx_gain_db']
    """
    # Unpack each sub-dictionary into local variables
    inp  = raw.get('inputs', {})
    ag   = raw.get('antenna_gains', {})
    bd   = raw.get('beam_divergence', {})
    ls   = raw.get('losses', {})
    rp   = raw.get('received_power', {})
    rpl  = raw.get('received_power_with_lna', {})
    lm   = raw.get('link_margin', {})

    # Also compute rx sensitivity in mW (if provided) for the frontend display
    rx_sens_dbm = inp.get('rx_sensitivity_dbm')
    rx_sens_mw  = dbm_to_mw(rx_sens_dbm) if rx_sens_dbm is not None else None

    # Return all values in one flat dictionary
    return {
        "tx_power_dbm":           inp.get('tx_power_dbm'),
        "tx_power_mw":            inp.get('tx_power_mw'),
        "rx_sensitivity_dbm":     rx_sens_dbm,
        "rx_sensitivity_mw":      rx_sens_mw,
        "rx_lna_gain_db":         inp.get('rx_lna_gain_db', 0),
        "distance_m":             inp.get('distance_m'),
        "distance_km":            inp.get('distance_km'),
        "wavelength_nm":          inp.get('wavelength_nm'),
        "tx_efficiency_percent":  inp.get('tx_efficiency_percent'),
        "rx_efficiency_percent":  inp.get('rx_efficiency_percent'),
        "tx_gain_db":             ag.get('tx_gain_db'),
        "tx_gain_absolute":       ag.get('tx_gain_abs'),
        "rx_gain_db":             ag.get('rx_gain_db'),
        "rx_gain_absolute":       ag.get('rx_gain_abs'),
        "tx_beam_divergence_rad": bd.get('tx_theta_rad'),
        "tx_beam_divergence_deg": bd.get('tx_theta_deg'),
        "rx_beam_divergence_rad": bd.get('rx_theta_rad'),
        "rx_beam_divergence_deg": bd.get('rx_theta_deg'),
        "path_loss_db":           ls.get('path_loss_db'),
        "impl_loss_db":           ls.get('implementation_loss_db'),
        "coupling_loss_db":       ls.get('coupling_loss_db'),
        "tx_pointing_loss_db":    ls.get('tx_pointing_loss_db'),
        "rx_pointing_loss_db":    ls.get('rx_pointing_loss_db'),
        "tx_efficiency_loss_db":  ls.get('tx_efficiency_loss_db'),
        "rx_efficiency_loss_db":  ls.get('rx_efficiency_loss_db'),
        "total_loss_db":          ls.get('total_loss_db'),
        "received_power_dbm":     rp.get('power_dbm'),
        "received_power_mw":      rp.get('power_mw'),
        "received_power_w":       rp.get('power_w'),
        "received_power_lna_dbm": rpl.get('power_dbm'),
        "received_power_lna_mw":  rpl.get('power_mw'),
        "received_power_lna_w":   rpl.get('power_w'),
        "link_margin_db":         lm.get('margin_db'),
        "link_viable":            lm.get('link_viable'),
    }


# =============================================================================
#  DATA MODELS  (Pydantic — defines what the API accepts and validates)
# =============================================================================
# Think of these as "typed input forms".
# FastAPI uses them to automatically:
#   1. Parse incoming JSON into Python objects
#   2. Validate every field (type, range, required/optional)
#   3. Return a clear 422 error if the frontend sends bad data

class LinkBudgetInput(BaseModel):
    """All the physical parameters for a single link-budget calculation."""
    tx_power_dbm:           float           = Field(..., description="Transmitter power in dBm")
    #   ... means required (no default). The frontend must always send this.
    tx_efficiency:          float           = Field(..., ge=0, le=1)   # ge=0: ≥0, le=1: ≤1
    tx_diameter_m:          float           = Field(..., gt=0)          # gt=0: must be > 0
    rx_efficiency:          float           = Field(..., ge=0, le=1)
    rx_diameter_m:          float           = Field(..., gt=0)
    rx_sensitivity_dbm:     Optional[float] = Field(None)              # Optional: link margin only if provided
    rx_lna_gain_db:         Optional[float] = Field(0.0, ge=0)         # defaults to 0 if not sent
    wavelength_m:           float           = Field(..., gt=0)
    distance_m:             float           = Field(..., gt=0)
    implementation_loss_db: Optional[float] = Field(0, ge=0)
    coupling_loss_db:       Optional[float] = Field(0, ge=0)
    tx_pointing_loss_db:    Optional[float] = Field(0, ge=0)
    rx_pointing_loss_db:    Optional[float] = Field(0, ge=0)
    tx_pointing_error_rad:  Optional[float] = Field(None, ge=0)        # if provided, overrides tx_pointing_loss_db
    rx_pointing_error_rad:  Optional[float] = Field(None, ge=0)        # if provided, overrides rx_pointing_loss_db


class SaveCalculationRequest(BaseModel):
    """Payload shape for saving a calculation to a JSON file."""
    calculation_name: str           = Field(..., min_length=1, max_length=100)
    inputs:           LinkBudgetInput     # the full set of inputs (reuses the model above)
    results:          Dict[str, Any]      # the calculated outputs (any key-value pairs)
    notes:            Optional[str] = Field(None, max_length=500)


class SweepRequest(BaseModel):
    """
    Payload for the parameter sweep endpoint.
    A sweep runs the link budget calculation repeatedly while one parameter
    changes from sweep_min to sweep_max over sweep_steps intervals.
    Optionally, a second parameter can be swept simultaneously (only used
    for simultaneous Tx+Rx pointing sweeps).
    """
    base_inputs:  LinkBudgetInput
    sweep_param:  str   = Field(..., description="Field name to sweep (e.g. 'distance_m')")
    sweep_min:    float = Field(..., description="Minimum value of sweep (SI units as expected by API)")
    sweep_max:    float = Field(..., description="Maximum value of sweep (SI units as expected by API)")
    sweep_steps:  int   = Field(..., ge=1, description="Number of intervals (num_points = steps + 1)")

    sweep_param2: Optional[str]   = Field(None, description="Optional second parameter to sweep simultaneously")
    sweep_min2:   Optional[float] = Field(None, description="Minimum value for second parameter")
    sweep_max2:   Optional[float] = Field(None, description="Maximum value for second parameter")


class PdfExportRequest(BaseModel):
    """Payload for generating a PDF report."""
    base_inputs:        Dict[str, Any]   # the original input parameters
    static_results:     Dict[str, Any]   # the single-point calculation result
    sweep_param:        Optional[str]    = None    # label of the swept parameter (if any)
    sweep_results:      Optional[list]   = None    # list of sweep data rows (if a sweep was run)
    chart_image_base64: Optional[str]    = None    # the chart as a base64 PNG string (if plotted)
    table_headers:      Optional[list]   = None    # column header names for the sweep table
    table_keys:         Optional[list]   = None    # the result keys that map to each column


# =============================================================================
#  API ENDPOINTS
# =============================================================================
# Each function below is decorated with @app.get() or @app.post().
# The decorator registers the function as a route — i.e. when the browser
# sends a request to that URL, FastAPI calls the corresponding function.
#
# "async def" means the function is asynchronous (non-blocking).
# FastAPI requires this so the server can handle multiple requests at once.

@app.get("/health")
async def health_check():
    """
    GET /health
    A simple "ping" endpoint the launcher uses to know when the server is
    ready to accept requests.  desktop_launcher.py polls this on startup.
    Returns: { "status": "healthy", "timestamp": "..." }
    """
    return {"status": "healthy", "timestamp": datetime.now().isoformat()}


@app.post("/api/calculate")
async def calculate_link_budget_endpoint(inputs: LinkBudgetInput):
    """
    POST /api/calculate
    Main calculation endpoint.  The frontend sends all the user's inputs
    as JSON; this function validates them, runs the link-budget maths,
    and returns the full flat result dictionary.

    Status codes:
      200 → success
      400 → invalid inputs (bad values, missing fields)
      500 → unexpected server error
    """
    try:
        # .dict() converts the Pydantic model into a plain Python dictionary
        params = inputs.dict()

        # Validate physical correctness (ranges, required fields)
        is_valid, error_msg = validate_inputs(params)
        if not is_valid:
            raise HTTPException(status_code=400, detail=error_msg)

        # Run the core calculation and flatten results into one level
        raw_results  = calculate_link_budget(params)
        flat_outputs = flatten_results(raw_results)

        return {
            "success":   True,
            "timestamp": datetime.now().isoformat(),
            "inputs":    inputs.dict(),   # echo back the inputs for reference
            "outputs":   flat_outputs     # the calculated results
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Calculation error: {str(e)}")


@app.post("/api/sweep")
async def sweep_link_budget_endpoint(request: SweepRequest):
    """
    POST /api/sweep
    Parameter sweep endpoint.  Runs the link budget many times, each time
    with one parameter changed by a small step.  Returns all results as a list.

    Example: sweep distance from 100 m to 10,000 m in 50 steps
    → returns 51 result points (steps+1 because both endpoints are included).

    Also supports sweeping two parameters at the same time (only Tx+Rx pointing).
    """
    try:
        # Save the sweep request to disk for debugging purposes (optional, harmless)
        with open("last_sweep_req.json", "w") as f:
            json.dump(request.dict(), f, indent=2)

        # Calculate how many total data points we need (intervals + 1)
        num_points = request.sweep_steps + 1
        # Calculate the step size between each point
        step_size  = (request.sweep_max - request.sweep_min) / request.sweep_steps if request.sweep_steps > 0 else 0
        # Build the full list of parameter values to sweep over
        sweep_values = [request.sweep_min + i * step_size for i in range(num_points)]

        # Handle optional second sweep parameter (simultaneous Tx+Rx pointing sweep)
        sweep_values2 = None
        if request.sweep_param2 and request.sweep_min2 is not None and request.sweep_max2 is not None:
            step_size2 = (request.sweep_max2 - request.sweep_min2) / request.sweep_steps if request.sweep_steps > 0 else 0
            sweep_values2 = [request.sweep_min2 + i * step_size2 for i in range(num_points)]

        # Validate that the requested parameter name actually exists in the model
        base_dict = request.base_inputs.dict()
        if request.sweep_param not in base_dict:
            raise HTTPException(status_code=400, detail=f"Unknown sweep parameter: {request.sweep_param}")

        if request.sweep_param2 and request.sweep_param2 not in base_dict:
            raise HTTPException(status_code=400, detail=f"Unknown sweep parameter 2: {request.sweep_param2}")

        # Run the calculation for every point in the sweep
        sweep_results = []
        for i, val in enumerate(sweep_values):
            params = dict(base_dict)   # fresh copy each iteration (don't mutate the original)
            params[request.sweep_param] = val  # override the swept parameter with this step's value

            # If there's a second sweep param, set it to its corresponding value
            if sweep_values2:
                params[request.sweep_param2] = sweep_values2[i]

            # Validate this particular combination of inputs before calculating
            is_valid, error_msg = validate_inputs(params)
            if not is_valid:
                raise HTTPException(status_code=400, detail=f"Invalid params at sweep value {val}: {error_msg}")

            # Run the calculation and flatten the results
            raw = calculate_link_budget(params)
            flat = flatten_results(raw)

            # Append this data point to the results list
            sweep_results.append({
                "sweep_value": val,    # the raw SI value of the swept parameter at this step
                "outputs":     flat    # all calculated results at this step
            })

        return {
            "success":     True,
            "sweep_param": request.sweep_param,
            "sweep_min":   request.sweep_min,
            "sweep_max":   request.sweep_max,
            "sweep_steps": request.sweep_steps,
            "num_points":  num_points,
            "results":     sweep_results,   # list of {sweep_value, outputs} for each point
            "timestamp":   datetime.now().isoformat()
        }

    except HTTPException:
        raise   # re-raise HTTP errors as-is (don't wrap them again)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Sweep error: {str(e)}")


@app.post("/api/save")
async def save_calculation(request: SaveCalculationRequest):
    """
    POST /api/save
    Saves a calculation (inputs + results + optional notes) to a JSON file
    inside the user's Documents/OpticalLinkCalculations folder.

    The filename is built from the user's chosen name + a timestamp,
    e.g. "My_Test_Link_20250607_123456.json".
    Special characters are stripped from the name to make a safe filename.
    """
    try:
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")   # e.g. "20250607_143022"

        # Build a filesystem-safe name: keep only alphanumeric, spaces, hyphens, underscores
        safe_name = "".join(
            c for c in request.calculation_name if c.isalnum() or c in (' ', '-', '_')
        ).strip().replace(' ', '_')  # replace spaces with underscores

        filename = f"{safe_name}_{timestamp}.json"
        filepath = os.path.join(STORAGE_DIR, filename)

        # Structure the data to be saved
        save_data = {
            "name":      request.calculation_name,
            "timestamp": datetime.now().isoformat(),
            "inputs":    request.inputs.dict(),
            "results":   request.results,
            "notes":     request.notes
        }

        # Write to disk as formatted JSON (indent=2 makes it human-readable)
        with open(filepath, 'w') as f:
            json.dump(save_data, f, indent=2)

        return {"success": True, "message": "Saved successfully", "filename": filename}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error saving: {str(e)}")


@app.get("/api/saved")
async def list_saved_calculations():
    """
    GET /api/saved
    Lists all saved calculation files in the storage directory.
    Returns a list sorted by timestamp (newest first).
    The frontend can use this to populate a "load calculation" dropdown.
    """
    try:
        saved_calcs = []
        if os.path.exists(STORAGE_DIR):
            for filename in os.listdir(STORAGE_DIR):   # loop through all files in the folder
                if filename.endswith('.json'):           # only process JSON files
                    filepath = os.path.join(STORAGE_DIR, filename)
                    try:
                        with open(filepath, 'r') as f:
                            data = json.load(f)
                            # Add a summary entry (don't load the full calculation data)
                            saved_calcs.append({
                                "filename":  filename,
                                "name":      data.get("name", "Unnamed"),
                                "timestamp": data.get("timestamp", "Unknown"),
                                "notes":     data.get("notes", "")
                            })
                    except Exception:
                        continue   # skip corrupt or unreadable files silently

        # Sort by timestamp string descending (newest file appears first)
        saved_calcs.sort(key=lambda x: x["timestamp"], reverse=True)
        return {"success": True, "count": len(saved_calcs), "calculations": saved_calcs}

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error listing: {str(e)}")


@app.post("/api/export_pdf")
async def export_pdf(request: PdfExportRequest):
    """
    POST /api/export_pdf
    Generates a PDF report from:
      - The input parameters used
      - The static (single-point) calculation results
      - Optionally: a sweep data table
      - Optionally: an embedded chart image (sent from the browser as base64)

    The PDF is saved to the same Documents/OpticalLinkCalculations folder
    and the file path is returned so the app can tell the user where it is.

    Uses the ReportLab library to build the PDF programmatically.
    """
    try:
        # io.BytesIO() creates an in-memory file buffer (like a RAM-based file)
        # We build the PDF here first, then write it to disk.
        buffer = io.BytesIO()

        # Create a document layout with letter-size page and 36-point (0.5 inch) margins
        doc = SimpleDocTemplate(buffer, pagesize=letter, rightMargin=36, leftMargin=36, topMargin=36, bottomMargin=36)
        elements = []  # list of PDF "story" elements (paragraphs, tables, images, spacers)

        # Get the built-in style set from ReportLab (Heading1, Heading2, Normal, etc.)
        styles = getSampleStyleSheet()
        title_style = styles['Heading1']
        title_style.alignment = 1   # 1 = center-aligned
        h2_style = styles['Heading2']

        # Custom text styles for table headers and cells
        table_hdr_style = ParagraphStyle(
            'TableHdr',
            parent=styles['Normal'],
            fontName='Helvetica-Bold',
            fontSize=8,
            leading=10,          # line height
            alignment=1,         # center
            textColor=colors.black
        )
        table_cell_style = ParagraphStyle(
            'TableCell',
            parent=styles['Normal'],
            fontName='Helvetica',
            fontSize=8,
            leading=10,
            alignment=1,
            textColor=colors.black
        )

        # --- Section 1: Title and generation timestamp ---
        elements.append(Paragraph("LB Sim Report", title_style))
        elements.append(Paragraph(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}", styles['Normal']))
        elements.append(Spacer(1, 12))   # 12-point vertical gap

        # --- Section 2: Input Parameters table ---
        elements.append(Paragraph("Input Parameters", h2_style))
        input_data = [["Parameter", "Value"]]   # header row
        # Loop through the base_inputs dict and add each parameter as a table row
        for k, v in request.base_inputs.items():
            input_data.append([get_pretty_label(str(k)), str(v)])

        t_in = Table(input_data, colWidths=[3*inch, 3*inch])
        t_in.setStyle(TableStyle([
            ('BACKGROUND', (0,0), (1,0), colors.HexColor("#c0c0c0")),  # grey header row background
            ('TEXTCOLOR', (0,0), (1,0), colors.black),
            ('ALIGN', (0,0), (-1,-1), 'LEFT'),
            ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
            ('BOTTOMPADDING', (0,0), (-1,0), 6),
            ('GRID', (0,0), (-1,-1), 0.5, colors.grey)   # thin grey grid lines
        ]))
        elements.append(t_in)
        elements.append(Spacer(1, 12))

        # --- Section 3: Static Results table (the single-point calculation output) ---
        if request.static_results:
            elements.append(Paragraph("Static Output Results (at base inputs)", h2_style))
            static_data = [["Parameter", "Value"]]

            # Recursive helper: flattens a nested dict into table rows
            def add_static_dict(d, prefix=""):
                for k, v in d.items():
                    if isinstance(v, dict):
                        # If the value is itself a dict, recurse with a label prefix
                        add_static_dict(v, prefix + get_pretty_label(str(k)) + " ")
                    else:
                        label = prefix + get_pretty_label(str(k))
                        if isinstance(v, float):
                            static_data.append([label, f"{v:.4f}"])   # 4 decimal places for floats
                        else:
                            static_data.append([label, str(v)])

            add_static_dict(request.static_results)

            t_stat = Table(static_data, colWidths=[3*inch, 3*inch])
            t_stat.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (1,0), colors.HexColor("#c0c0c0")),
                ('TEXTCOLOR', (0,0), (1,0), colors.black),
                ('ALIGN', (0,0), (-1,-1), 'LEFT'),
                ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
                ('BOTTOMPADDING', (0,0), (-1,0), 6),
                ('GRID', (0,0), (-1,-1), 0.5, colors.grey)
            ]))
            elements.append(t_stat)
            elements.append(Spacer(1, 12))

        # --- Section 4: Embedded chart image (if a sweep graph was plotted) ---
        if request.chart_image_base64:
            # The browser sends the chart canvas as a data URL:
            # "data:image/png;base64,iVBORw0KGgo..."
            # We split on the comma to get just the base64 part, then decode it.
            header, encoded = request.chart_image_base64.split(",", 1)
            img_data = base64.b64decode(encoded)    # decode base64 → raw PNG bytes
            img_stream = io.BytesIO(img_data)       # wrap bytes in a file-like object
            img = Image(img_stream, width=6*inch, height=3*inch)
            elements.append(Paragraph("Sweep Graph", h2_style))
            elements.append(img)
            elements.append(Spacer(1, 12))

        # --- Section 5: Sweep data table ---
        if request.sweep_results and request.table_headers and request.table_keys:
            elements.append(Paragraph(f"Sweep Results: {request.sweep_param}", h2_style))
            # Build header row from the provided column names
            sweep_table_data = [[Paragraph(h, table_hdr_style) for h in request.table_headers]]
            for row in request.sweep_results:
                row_data = []
                for key in request.table_keys:
                    val = row.get(key, '—')   # '—' if a value is missing
                    if isinstance(val, float):
                        val_str = f"{val:.4f}"
                    else:
                        val_str = str(val)
                    row_data.append(Paragraph(val_str, table_cell_style))
                sweep_table_data.append(row_data)

            # Distribute columns evenly across the 7-inch page width
            num_cols = len(request.table_headers)
            col_w = 7.0*inch / num_cols if num_cols else 1*inch
            t_sweep = Table(sweep_table_data, colWidths=[col_w]*num_cols, repeatRows=1)
            # repeatRows=1 means the header row repeats at the top of every page
            t_sweep.setStyle(TableStyle([
                ('BACKGROUND', (0,0), (-1,0), colors.HexColor("#c0c0c0")),
                ('TEXTCOLOR', (0,0), (-1,0), colors.black),
                ('ALIGN', (0,0), (-1,-1), 'CENTER'),
                ('FONTNAME', (0,0), (-1,0), 'Helvetica-Bold'),
                ('FONTSIZE', (0,0), (-1,-1), 8),
                ('BOTTOMPADDING', (0,0), (-1,0), 6),
                ('GRID', (0,0), (-1,-1), 0.5, colors.grey)
            ]))
            elements.append(t_sweep)

        # --- Build the PDF and save it to a file ---
        filename = f"LBSim_Report_{datetime.now().strftime('%Y%m%d_%H%M%S')}.pdf"
        filepath = os.path.join(STORAGE_DIR, filename)

        # Create the final document object (this time pointing to an actual file path)
        doc = SimpleDocTemplate(filepath, pagesize=letter, rightMargin=36, leftMargin=36, topMargin=36, bottomMargin=36)
        doc.build(elements)   # this writes all elements to the file

        return {"success": True, "message": "PDF generated successfully", "filepath": filepath, "filename": filename}

    except Exception as e:
        import traceback
        traceback.print_exc()   # print the full error to the server console for debugging
        raise HTTPException(status_code=500, detail=f"Error generating PDF: {str(e)}")


@app.get("/api/load/{filename}")
async def load_calculation(filename: str):
    """
    GET /api/load/{filename}
    Loads a previously saved calculation JSON file from disk and returns
    its contents so the frontend can repopulate the input fields.

    {filename} in the URL is a path parameter — FastAPI extracts it automatically.
    e.g. GET /api/load/MyCalc_20250607_120000.json
    """
    try:
        filepath = os.path.join(STORAGE_DIR, filename)
        if not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="Calculation not found")
        with open(filepath, 'r') as f:
            data = json.load(f)
        return {"success": True, "data": data}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error loading: {str(e)}")


@app.delete("/api/delete/{filename}")
async def delete_calculation(filename: str):
    """
    DELETE /api/delete/{filename}
    Permanently deletes a saved calculation file from disk.
    HTTP DELETE method is used (not GET/POST) as it's semantically correct
    for destructive operations.
    """
    try:
        filepath = os.path.join(STORAGE_DIR, filename)
        if not os.path.exists(filepath):
            raise HTTPException(status_code=404, detail="Calculation not found")
        os.remove(filepath)   # permanently delete the file
        return {"success": True, "message": "Deleted successfully"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error deleting: {str(e)}")


# =============================================================================
#  SERVE FRONTEND FILES
# =============================================================================

import sys

def get_base_path():
    """
    Returns the root directory of the project, whether running:
      - Normally in dev (base_path = the project root folder)
      - As a compiled .exe via PyInstaller (base_path = the temp folder PyInstaller
        extracts bundled files into, stored in sys._MEIPASS)

    This is needed because when PyInstaller creates the .exe, it extracts all
    bundled files to a temporary folder at runtime. sys._MEIPASS is PyInstaller's
    magic attribute that holds that temp path.
    """
    try:
        # PyInstaller creates a temp folder and stores its path in _MEIPASS
        base_path = sys._MEIPASS
    except Exception:
        # Running in normal dev mode — go one level up from backend/ to the project root
        base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return base_path


# Build the path to the frontend folder
base_dir = get_base_path()
frontend_path = os.path.join(base_dir, 'frontend')

# Mount the entire frontend/ directory at the root URL ("/").
# This means: visiting http://localhost:8000/ serves frontend/retro_preview.html
# and the browser can also load app_v3.js, styles, etc. from there.
#
# IMPORTANT: this is registered LAST, after all API routes.
# FastAPI checks routes in order, so /api/calculate is matched before the catch-all "/".
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="static")


# =============================================================================
#  ENTRY POINT  (only runs when this file is executed directly)
# =============================================================================

if __name__ == "__main__":
    # This block only runs when you do:  python main.py
    # When launched by desktop_launcher.py via subprocess, uvicorn is invoked
    # differently (not through __main__), so this block is NOT used in the .exe.
    # It's here for convenience during development/testing.
    uvicorn.run(
        "main:app",      # "module_name:app_object"
        host="0.0.0.0",  # listen on all network interfaces (not just localhost)
        port=8000,        # port number the server listens on
        reload=True,      # auto-restart on code changes (dev only, not in .exe)
        log_level="info"  # print INFO-level logs to the console
    )
