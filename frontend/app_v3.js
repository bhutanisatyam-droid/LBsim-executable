/**
 * =============================================================================
 *  LBSim - Frontend Logic  (frontend/app_v3.js)
 * =============================================================================
 *
 *  WHAT IS THIS FILE?
 *  ------------------
 *  This is the "brain" of the user interface. It is JavaScript — a programming
 *  language that runs directly inside the browser/webview window (not on the
 *  server). While Python handles maths on the backend, JavaScript handles
 *  everything the user sees and clicks on in real time.
 *
 *  WHAT DOES IT DO?
 *  ----------------
 *  1. Reads values from all the input fields when the user clicks RUN
 *  2. Converts them to the correct units (e.g. cm → m, mW → dBm)
 *  3. Sends those values to the Python backend over HTTP (like a form submission)
 *  4. Receives the JSON result back and displays it on the screen
 *  5. Handles sweep mode (run calculation many times while one parameter varies)
 *  6. Draws the sweep chart using Chart.js (a graphing library)
 *  7. Populates the sweep data table
 *  8. Triggers PDF export by sending data to the backend
 *  9. Controls the custom Win95-style window buttons (minimize/maximize/close)
 *     by calling into the Python desktop_launcher.py via the pywebview bridge
 *
 *  HOW IT RELATES TO THE OTHER FILES:
 *  -----------------------------------
 *  retro_preview.html  →  the visual layout (buttons, input boxes, panels)
 *  app_v3.js           →  (THIS FILE) makes everything interactive and dynamic
 *  backend/main.py     →  receives our data, does the physics, sends results back
 *
 *  NOTE ON JAVASCRIPT SYNTAX (for Python developers):
 *  ---------------------------------------------------
 *  - `const`  = a variable that won't be reassigned (like a final binding)
 *  - `let`    = a variable that can be reassigned (like a normal Python variable)
 *  - `function foo() {}` = def foo():
 *  - `=>` in `(x) => x + 1` is an "arrow function" = Python lambda: lambda x: x+1
 *  - `async function foo()` = Python's async def foo()
 *  - `await fetch(...)` = like Python's await — waits for a network response
 *  - `document.getElementById('id')` = finds an HTML element by its id attribute
 *  - `element.addEventListener('click', fn)` = attaches a listener (like a signal handler)
 *  - `//` = single-line comment (same as Python's #)
 *  - `null` = Python's None
 * =============================================================================
 */


// =============================================================================
//  GLOBAL STATE VARIABLES
//  These hold shared data that multiple functions need access to.
//  In Python terms, think of them as module-level variables.
// =============================================================================

// The base URL of our Python backend server.
// If the page is opened directly as a file:// URL (shouldn't happen in normal use),
// we fall back to localhost:8000.  Otherwise we use the same origin as the page.
const API_BASE_URL = window.location.origin.includes('file://') ? 'http://localhost:8000' : window.location.origin;

// Stores the result of the most recent single-point calculation.
// Set when /api/calculate responds; cleared on Reset.
let currentCalculationData = null;

// Holds the Chart.js chart object so we can destroy and recreate it on each new sweep.
// (You must destroy a Chart.js instance before drawing a new one on the same canvas.)
let sweepChartInstance = null;

// Stores the full list of sweep result points from the most recent /api/sweep call.
// Each item looks like: { sweep_value: 500, outputs: { path_loss_db: 120.5, ... } }
let currentSweepResults = null;

// Short key identifying which parameter was swept last (e.g. 'dist', 'tx', 'wave').
// Used by display helpers to apply the correct unit conversions.
let currentSweepParamKey = null;

// Human-readable label for the currently swept parameter (e.g. "Distance", "Tx Power").
// Used in chart axis labels and the sweep info span.
let currentSweepLabel = null;


// =============================================================================
//  PAGE LOAD EVENT
//  This block runs once when the HTML page has fully loaded and is ready.
//  In Python terms: if __name__ == "__main__": ...
//  All button click handlers are wired up here.
// =============================================================================

document.addEventListener('DOMContentLoaded', () => {
    // --- RUN button ---
    // When clicked, decides whether to do a single calculation or a sweep.
    document.getElementById('btnRun').addEventListener('click', handleCalculateClick);

    // --- Iteration dropdown ---
    // In sweep mode, a dropdown lets the user pick which sweep point to display.
    // When they change it, update the results panel to show that iteration's values.
    document.getElementById('iteration_dropdown').addEventListener('change', handleIterationChange);

    // --- "No sweep" radio buttons ---
    // Each parameter has a Yes/No sweep toggle (radio buttons).
    // When the user clicks "No" for any parameter, we clear sweep results and the chart
    // because the sweep is no longer active.
    const sweepNoRadios = [
        'sweep_no_1', 'sweep_no_2', 'sweep_no_3', 'sweep_no_4', 'sweep_no_5',
        'sw_tx_eff_n', 'sw_rx_eff_n', 'sweep_no_7', 'sw_sys_loss_n', 'sw_cpl_loss_n',
        'sw_tx_pt_n', 'sw_rx_pt_n', 'sw_lna_n'
    ];
    sweepNoRadios.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.addEventListener('change', () => {
                if (el.checked) {
                    currentSweepResults = null;           // discard old sweep data
                    if (sweepChartInstance) {
                        sweepChartInstance.destroy();     // remove the existing chart
                        sweepChartInstance = null;
                    }
                    hideGraph();                          // hide the chart area
                    const infoSpan = document.getElementById('iteration_sweep_info');
                    if (infoSpan) infoSpan.textContent = '';   // clear the sweep info label
                }
            });
        }
    });

    // --- Result unit dropdowns ---
    // When the user changes the display unit for received power or link margin,
    // immediately re-render the results panel without recalculating.
    document.getElementById('res_rx_power_unit').addEventListener('change', () => {
        if (currentCalculationData) displayResults(currentCalculationData);
        else if (currentSweepResults) handleIterationChange();
    });

    document.getElementById('res_link_margin_unit').addEventListener('change', () => {
        if (currentCalculationData) displayResults(currentCalculationData);
        else if (currentSweepResults) handleIterationChange();
    });

    // --- Plot Graph button ---
    // Opens the sweep graph modal and draws the chart if sweep data exists.
    const btnPlotGraph = document.getElementById('btnPlotGraph');
    if (btnPlotGraph) {
        btnPlotGraph.addEventListener('click', () => {
            if (currentSweepResults && currentSweepResults.length > 0) {
                drawChart(currentSweepResults, currentSweepLabel);
            } else {
                alert("No sweep data to plot! Please run a sweep first.");
            }
        });
    }

    // --- Plot Table button ---
    // Opens the sweep table modal and populates the data table if sweep data exists.
    const btnPlotTable = document.getElementById('btnPlotTable');
    if (btnPlotTable) {
        btnPlotTable.addEventListener('click', () => {
            if (currentSweepResults && currentSweepResults.length > 0) {
                drawTable(currentSweepResults, currentSweepLabel);
                document.getElementById('sweepTableModal').style.display = 'flex';  // show the modal
            } else {
                alert("No sweep data to plot! Please run a sweep first.");
            }
        });
    }

    // --- Demo Data button ---
    // Fills in a pre-set example scenario so the user can see what the app does
    // without typing anything. Sets a distance sweep from 100–1000 m in 10 steps.
    const btnDemoData = document.getElementById('btnDemoData');
    if (btnDemoData) {
        btnDemoData.addEventListener('click', () => {
            // Set each input field to a sensible demo value
            document.getElementById('txPower').value = "0";
            document.getElementById('txPowerUnit').value = "dBm";
            document.getElementById('sweep_no_1').checked = true;   // no sweep on this param

            document.getElementById('wavelength').value = "1550";   // 1550 nm = common telecom wavelength
            document.getElementById('wavelengthUnit').value = "nm";
            document.getElementById('sweep_no_2').checked = true;

            document.getElementById('distance').value = "10";
            document.getElementById('distanceUnit').value = "m";
            document.getElementById('sweep_yes_3').checked = true;  // YES sweep on distance
            document.getElementById('sw_dist_range').value = "100-1000";  // sweep 100 m → 1000 m
            document.getElementById('sw_dist_step').value = "10";         // in 10 steps

            document.getElementById('txDiameter').value = "2";
            document.getElementById('txDiameterUnit').value = "cm";
            document.getElementById('sweep_no_4').checked = true;

            document.getElementById('rxDiameter').value = "2";
            document.getElementById('rxDiameterUnit').value = "cm";
            document.getElementById('sweep_no_5').checked = true;

            document.getElementById('txEfficiency').value = "50";   // 50%
            document.getElementById('txEfficiencyUnit').value = "%";
            document.getElementById('sw_tx_eff_n').checked = true;

            document.getElementById('rxEfficiency').value = "50";
            document.getElementById('rxEfficiencyUnit').value = "%";
            document.getElementById('sw_rx_eff_n').checked = true;

            document.getElementById('rxSensitivity').value = "-23";  // -23 dBm sensitivity
            document.getElementById('rxSensitivityUnit').value = "dBm";
            document.getElementById('sweep_no_7').checked = true;

            document.getElementById('sysLoss').value = "2";
            document.getElementById('sysLossUnit').value = "dB";
            document.getElementById('sw_sys_loss_n').checked = true;

            document.getElementById('cplLoss').value = "8";
            document.getElementById('cplLossUnit').value = "dB";
            document.getElementById('sw_cpl_loss_n').checked = true;

            // Enable pointing error mode and set 20 µrad pointing error on both Tx and Rx
            document.getElementById('pt_err').checked = true;
            if (typeof togglePointingUnits === 'function') {
                togglePointingUnits();   // update the unit dropdowns to show angle units
            }
            document.getElementById('txPointing').value = "20";
            document.getElementById('tx_pt_unit').value = "urad";
            document.getElementById('sw_tx_pt_n').checked = true;

            document.getElementById('rxPointing').value = "20";
            document.getElementById('rx_pt_unit').value = "urad";
            document.getElementById('sw_rx_pt_n').checked = true;

            document.getElementById('rxLnaGain').value = "0";   // no LNA
            document.getElementById('rxLnaGainUnit').value = "dB";
            document.getElementById('sw_lna_n').checked = true;

            // Programmatically trigger the sweep_yes_3 'change' event so the UI
            // shows the sweep range fields for distance.
            const event = new Event('change');
            document.getElementById('sweep_yes_3').dispatchEvent(event);
        });
    }

    // --- Reset button ---
    // Clears all input fields back to defaults and resets the results panel.
    const btnReset = document.getElementById('btnReset');
    if (btnReset) {
        btnReset.addEventListener('click', () => {
            // List of all text input field IDs to blank out
            const textInputs = [
                'txPower', 'wavelength', 'distance', 'txDiameter', 'rxDiameter',
                'txEfficiency', 'rxEfficiency', 'rxSensitivity', 'sysLoss', 'cplLoss',
                'txPointing', 'rxPointing', 'rxLnaGain', 'sw_tx_range', 'sw_tx_step',
                'sw_wave_range', 'sw_wave_step', 'sw_dist_range', 'sw_dist_step',
                'sw_txd_range', 'sw_txd_step', 'sw_rxd_range', 'sw_rxd_step',
                'sw_tx_eff_range', 'sw_tx_eff_step', 'sw_rx_eff_range', 'sw_rx_eff_step',
                'sw_sens_range', 'sw_sens_step', 'sw_sys_loss_range', 'sw_sys_loss_step',
                'sw_cpl_loss_range', 'sw_cpl_loss_step', 'sw_tx_pt_range', 'sw_tx_pt_step',
                'sw_rx_pt_range', 'sw_rx_pt_step', 'sw_lna_range', 'sw_lna_step'
            ];
            textInputs.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';   // blank each field
            });

            // Reset all unit dropdowns to their default values
            const selects = {
                txPowerUnit: 'mW', wavelengthUnit: 'nm', distanceUnit: 'm',
                txDiameterUnit: 'm', rxDiameterUnit: 'm', txEfficiencyUnit: 'dec',
                rxEfficiencyUnit: 'dec', rxSensitivityUnit: 'dBm', sysLossUnit: 'dB',
                cplLossUnit: 'dB', tx_pt_unit: 'rad', rx_pt_unit: 'rad', rxLnaGainUnit: 'dB'
            };
            Object.entries(selects).forEach(([id, val]) => {
                const el = document.getElementById(id);
                if (el) el.value = val;
            });

            // Reset all sweep toggle radios to "No" (no sweep on any parameter)
            const sweepNoRadios = [
                'sweep_no_1', 'sweep_no_2', 'sweep_no_3', 'sweep_no_4', 'sweep_no_5',
                'sw_tx_eff_n', 'sw_rx_eff_n', 'sweep_no_7', 'sw_sys_loss_n', 'sw_cpl_loss_n',
                'sw_tx_pt_n', 'sw_rx_pt_n', 'sw_lna_n'
            ];
            sweepNoRadios.forEach(id => {
                const el = document.getElementById(id);
                if (el) el.checked = true;
            });

            // Reset pointing mode back to "error angle" mode
            const ptErr = document.getElementById('pt_err');
            if (ptErr) {
                ptErr.checked = true;
                if (typeof togglePointingUnits === 'function') togglePointingUnits();
            }

            // Reset all result display fields back to placeholder text
            document.getElementById('res_rx_power').innerText = 'XX.XX';
            document.getElementById('res_link_margin').innerText = 'XX.X';
            document.getElementById('res_link_margin').style.color = '';    // clear green/red colour
            document.getElementById('res_tx_gain').innerText = 'XX.X dB';
            document.getElementById('res_rx_gain').innerText = 'XX.X dB';
            document.getElementById('res_tx_eff_loss').innerText = 'X.X dB';
            document.getElementById('res_rx_eff_loss').innerText = 'X.X dB';
            document.getElementById('res_path_loss').innerText = 'XXX.X dB';
            document.getElementById('res_other_loss').innerText = 'XX.X dB';
            document.getElementById('res_tx_pl_loss').innerText = 'XX.X dB';
            document.getElementById('res_rx_pl_loss').innerText = 'XX.X dB';

            // Clear all global state
            currentCalculationData = null;
            currentSweepResults = null;
            currentSweepParamKey = null;
            currentSweepLabel = null;
            updateXAxisOptionText();    // reset the x-axis dropdown label

            if (sweepChartInstance) {
                sweepChartInstance.destroy();  // destroy the chart so canvas is clean
                sweepChartInstance = null;
            }

            // Trigger the sweep_no_3 change event so the distance sweep fields hide
            const event = new Event('change');
            document.getElementById('sweep_no_3').dispatchEvent(event);
        });
    }

    // --- Export PDF button ---
    // Collects the current inputs + results + chart image and sends them to
    // the backend /api/export_pdf endpoint, which generates and saves the PDF.
    const btnExportPdf = document.getElementById('btnExportPdf');
    if (btnExportPdf) {
        btnExportPdf.addEventListener('click', async () => {
            // Collect the current input field values as a plain object
            const base_inputs = collectInputs();

            // If a sweep chart is visible, capture it as a base64 PNG string.
            // The HTML <canvas> element (used by Chart.js) has a toDataURL() method
            // that serialises the chart image as text we can send in JSON.
            let chart_image_base64 = null;
            if (sweepChartInstance) {
                const canvas = document.getElementById('sweepChart');
                if (canvas) {
                    chart_image_base64 = canvas.toDataURL("image/png");
                    // result looks like: "data:image/png;base64,iVBOR..."
                }
            }

            // If sweep data exists, build the column headers and key names for the PDF table.
            // We match the columns the user currently has selected in the axis dropdowns.
            let table_headers = null;
            let table_keys = null;
            if (currentSweepResults && currentSweepResults.length > 0) {
                const xAxisSelect = document.getElementById('plot_x_axis');
                const xAxisKey = xAxisSelect.value;
                const xAxisLabel = getSweepAxisLabel(xAxisKey, xAxisSelect.options[xAxisSelect.selectedIndex].text);

                const yAxisSelect = document.getElementById('plot_y_axis');
                const yAxisKey = yAxisSelect.value;
                const yAxisLabel = yAxisSelect.options[yAxisSelect.selectedIndex].text;

                const yAxisRightSelect = document.getElementById('plot_y_axis_right');
                const yAxisRightKey = yAxisRightSelect ? yAxisRightSelect.value : 'none';
                const yAxisRightLabel = yAxisRightSelect && yAxisRightKey !== 'none' ? yAxisRightSelect.options[yAxisRightSelect.selectedIndex].text : '';

                // Start with the two user-selected axes
                table_headers = [xAxisLabel, yAxisLabel];
                table_keys = [xAxisKey === 'sweep_value' ? 'sweep_value' : xAxisKey, yAxisKey];

                // Add the optional right y-axis column if one is selected
                if (yAxisRightKey !== 'none') {
                    table_headers.push(yAxisRightLabel);
                    table_keys.push(yAxisRightKey);
                }

                // Always include Link Margin, Received Power, and Path Loss as extra columns
                // (unless they are already shown as the primary y-axis)
                if (yAxisKey !== 'link_margin_db' && yAxisRightKey !== 'link_margin_db') {
                    table_headers.push("Link Margin (dB)");
                    table_keys.push("link_margin_db");
                }
                if (yAxisKey !== 'received_power_lna_dbm' && yAxisRightKey !== 'received_power_lna_dbm') {
                    table_headers.push("Received Power (dBm)");
                    table_keys.push("received_power_lna_dbm");
                }
                if (yAxisKey !== 'path_loss_db' && yAxisRightKey !== 'path_loss_db') {
                    table_headers.push("Path Loss (dB)");
                    table_keys.push("path_loss_db");
                }
                table_headers.push("Viable");
                table_keys.push("link_viable");
            }

            // Convert sweep results into a flat format suitable for the PDF table.
            // The backend expects an array of flat objects (not nested {sweep_value, outputs}).
            let sweep_results = null;
            if (currentSweepResults) {
                sweep_results = currentSweepResults.map(r => {
                    // Start with the display-unit version of the sweep value
                    let d = { sweep_value: getDisplaySweepValue(r.sweep_value, currentSweepParamKey) };
                    // Merge all the outputs into the same flat object (Object.assign = dict.update)
                    Object.assign(d, r.outputs);
                    // Fall back to non-LNA power if LNA power is missing
                    if (d.received_power_lna_dbm === undefined || d.received_power_lna_dbm === null) {
                        d.received_power_lna_dbm = d.received_power_dbm;
                    }
                    // Convert boolean link_viable to a human-readable string
                    d.link_viable = d.link_viable === true ? "Yes" : (d.link_viable === false ? "No" : "—");
                    return d;
                });
            }

            // Build the complete JSON payload to send to /api/export_pdf
            const payload = {
                base_inputs: base_inputs,
                static_results: currentCalculationData ? currentCalculationData : {},
                sweep_param: currentSweepLabel,
                sweep_results: sweep_results,
                chart_image_base64: chart_image_base64,
                table_headers: table_headers,
                table_keys: table_keys
            };

            try {
                // Send the payload to the Python backend.
                // fetch() is the modern browser way to make HTTP requests (like Python's requests.post).
                // 'await' pauses here until the server responds.
                const response = await fetch(`${API_BASE_URL}/api/export_pdf`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)   // convert JS object → JSON string
                });

                if (!response.ok) {
                    throw new Error("Failed to export PDF");
                }

                const result = await response.json();   // parse the JSON response
                alert(`Success! PDF saved to:\n${result.filepath}`);  // tell the user where the file is
            } catch (err) {
                console.error(err);   // log to browser dev console
                alert("Error exporting PDF: " + err.message);
            }
        });
    }

    // --- Custom window control buttons (Win95 title bar) ---
    // These call into the Python desktop_launcher.py via the pywebview JS bridge.
    // window.pywebview.api is an object that maps to the Api class in desktop_launcher.py.

    // Minimize button → tells pywebview to minimize the window
    const btnWinMinimize = document.getElementById('btnWinMinimize');
    if (btnWinMinimize) {
        btnWinMinimize.addEventListener('click', () => {
            if (window.pywebview && window.pywebview.api) {
                window.pywebview.api.minimize();
            }
        });
    }

    // Maximize/restore button → toggles between maximized and normal window size
    const btnWinMaximize = document.getElementById('btnWinMaximize');
    if (btnWinMaximize) {
        btnWinMaximize.addEventListener('click', () => {
            if (window.pywebview && window.pywebview.api) {
                window.pywebview.api.maximize();
            }
        });
    }

    // X (close) button in the title bar → shuts down the entire application
    const btnWinClose = document.getElementById('btnWinClose');
    if (btnWinClose) {
        btnWinClose.addEventListener('click', () => {
            if (window.pywebview && window.pywebview.api) {
                window.pywebview.api.close();
            }
        });
    }

    // EXIT button in the menu bar → same as the X button
    const btnExit = document.getElementById('btnExit');
    if (btnExit) {
        btnExit.addEventListener('click', () => {
            if (window.pywebview && window.pywebview.api) {
                window.pywebview.api.close();
            }
        });
    }

    // (Internal helper defined but not wired to a button — kept for future use)
    const updatePlotsOnSelectionChange = () => {
        if (currentSweepResults && currentSweepResults.length > 0) {
            drawChart(currentSweepResults, currentSweepLabel);
            drawTable(currentSweepResults, currentSweepLabel);
        }
    };

    // Plot buttons are handled at the top of the DOMContentLoaded listener.
});


// =============================================================================
//  UNIT CONVERSION HELPERS
//  The user can enter values in many units (mW, dBm, cm, nm, µrad, etc.)
//  These functions convert whatever the user typed into the SI base unit
//  that the backend always expects.
// =============================================================================

// Power conversions
function mWtoDBm(mW)  { return 10 * Math.log10(mW); }         // milliwatts → dBm
function dBmToMW(dBm) { return Math.pow(10, dBm / 10); }      // dBm → milliwatts
function WtoDBm(W)    { return 10 * Math.log10(W * 1000); }   // Watts → dBm (via mW)
function linearToDb(l){ return 10 * Math.log10(l); }          // linear ratio → dB

// Distance/length: always convert to metres (m)
function convertToMeters(value, unit) {
    if (unit === 'cm')    return value / 100;
    if (unit === 'mm')    return value / 1000;
    if (unit === 'km')    return value * 1000;
    if (unit === 'miles') return value * 1609.34;
    return value;   // already in metres
}

// Wavelength: always convert to nanometres (nm), then the API converts nm→m
function convertToNanometers(value, unit) {
    if (unit === 'µm') return value * 1000;  // micrometres → nm
    if (unit === 'm')  return value * 1e9;   // metres → nm
    return value;   // already in nm
}

// Power: always convert to dBm (the API works in dBm for Tx power and sensitivity)
function convertPowerToDBm(value, unit) {
    if (unit === 'mW') return mWtoDBm(value);
    if (unit === 'W')  return WtoDBm(value);
    return value;   // already in dBm
}

// Efficiency: always convert to a percentage (0–100)
// Then collectInputs() divides by 100 to get a decimal (0–1) for the API.
function convertToPercent(value, unit) {
    if (unit === 'decimal' || unit === 'dec') return value * 100;
    return value;   // already in %
}

// Loss: always convert to dB (the API expects dB)
function convertLossToDb(value, unit) {
    if (unit === 'linear') return linearToDb(value);
    return value;   // already in dB
}

// Pointing angle: always convert to radians (the API always uses radians)
function convertAngleToRadians(value, unit) {
    if (!value) return 0;
    const lUnit = unit.toLowerCase();
    if (lUnit === 'urad' || lUnit === 'µrad') return value * 1e-6;   // microradians → rad
    if (lUnit === 'nrad')                     return value * 1e-9;   // nanoradians → rad
    if (lUnit === 'deg' || lUnit === 'degrees') return value * (Math.PI / 180);
    if (lUnit === 'mrad')                     return value * 1e-3;   // milliradians → rad
    return value;   // already in radians
}


// =============================================================================
//  getDisplaySweepValue
//  When displaying sweep results to the user, we need to convert the raw SI
//  value back into whatever unit the user selected.
//  e.g. the backend stores distance in metres, but if the user selected "km",
//  we should show the value in km.
// =============================================================================

function getDisplaySweepValue(sweepValue, sweepParamKey) {
    let displayValue = sweepValue;
    if (!sweepParamKey) return displayValue;

    // For each swept parameter, check what unit the user chose and back-convert
    if (sweepParamKey === 'tx') {
        // Tx Power was swept in dBm internally; display back in the user's chosen unit
        const unit = document.getElementById('txPowerUnit').value;
        if (unit === 'mW') displayValue = dBmToMW(sweepValue);
        if (unit === 'W')  displayValue = dBmToMW(sweepValue) / 1000;
    } else if (sweepParamKey === 'wave') {
        // Wavelength was swept in metres; display in nm or µm
        const unit = document.getElementById('wavelengthUnit').value;
        if (unit === 'nm') displayValue = sweepValue * 1e9;
        if (unit === 'µm') displayValue = sweepValue * 1e6;
    } else if (sweepParamKey === 'dist') {
        // Distance was swept in metres; display in km or miles if selected
        const unit = document.getElementById('distanceUnit').value;
        if (unit === 'km')    displayValue = sweepValue / 1000;
        if (unit === 'miles') displayValue = sweepValue / 1609.34;
    } else if (sweepParamKey === 'txd') {
        // Tx Diameter was swept in metres; display in cm or mm if selected
        const unit = document.getElementById('txDiameterUnit').value;
        if (unit === 'cm') displayValue = sweepValue * 100;
        if (unit === 'mm') displayValue = sweepValue * 1000;
    } else if (sweepParamKey === 'rxd') {
        const unit = document.getElementById('rxDiameterUnit').value;
        if (unit === 'cm') displayValue = sweepValue * 100;
        if (unit === 'mm') displayValue = sweepValue * 1000;
    } else if (sweepParamKey === 'tx_eff') {
        // Efficiency was swept as decimal (0–1); display in % if selected
        const unit = document.getElementById('txEfficiencyUnit').value;
        if (unit === '%') displayValue = sweepValue * 100;
    } else if (sweepParamKey === 'rx_eff') {
        const unit = document.getElementById('rxEfficiencyUnit').value;
        if (unit === '%') displayValue = sweepValue * 100;
    } else if (sweepParamKey === 'sens') {
        const unit = document.getElementById('rxSensitivityUnit').value;
        if (unit === 'mW') displayValue = dBmToMW(sweepValue);
    } else if (sweepParamKey === 'sys_loss') {
        const unit = document.getElementById('sysLossUnit').value;
        if (unit === 'linear') displayValue = Math.pow(10, sweepValue / 10);  // dB → linear
    } else if (sweepParamKey === 'cpl_loss') {
        const unit = document.getElementById('cplLossUnit').value;
        if (unit === 'linear') displayValue = Math.pow(10, sweepValue / 10);
    } else if (sweepParamKey === 'tx_pt') {
        // Pointing was swept either as angle (rad) or as loss (dB)
        const isError = document.getElementById('pt_err').checked;
        const unit = document.getElementById('tx_pt_unit').value;
        if (isError) {
            // Angle mode: convert rad back to the user's angle unit
            if (unit === 'urad' || unit === 'µrad') displayValue = sweepValue * 1e6;
            if (unit === 'nrad')                    displayValue = sweepValue * 1e9;
            if (unit === 'deg' || unit === 'degrees') displayValue = sweepValue * (180 / Math.PI);
        } else {
            // Direct loss mode: convert dB back to linear if needed
            if (unit === 'linear') displayValue = Math.pow(10, sweepValue / 10);
        }
    } else if (sweepParamKey === 'rx_pt') {
        const isError = document.getElementById('pt_err').checked;
        const unit = document.getElementById('rx_pt_unit').value;
        if (isError) {
            if (unit === 'urad' || unit === 'µrad') displayValue = sweepValue * 1e6;
            if (unit === 'nrad')                    displayValue = sweepValue * 1e9;
            if (unit === 'deg' || unit === 'degrees') displayValue = sweepValue * (180 / Math.PI);
        } else {
            if (unit === 'linear') displayValue = Math.pow(10, sweepValue / 10);
        }
    }
    return displayValue;
}


// =============================================================================
//  SWEEP PARAMS MAP
//  A lookup table (object) that describes each sweepable parameter:
//    name      → the shared name of the radio button group in the HTML
//    rangeId   → ID of the "range" text field (e.g. "100-1000")
//    stepId    → ID of the "steps" text field (e.g. "10")
//    apiKey    → the JSON key name the backend expects for this parameter
//    label     → human-readable display name used in chart labels
//    toSI      → arrow function that converts the user's display value to SI for the API
//
//  tx_pt and rx_pt use getApiKey/getToSI (functions instead of values)
//  because the API key and conversion depend on whether "error angle" or
//  "direct loss" mode is selected at runtime.
// =============================================================================

const SWEEP_PARAMS = {
    'tx': {
        name: 'sweep_tx', rangeId: 'sw_tx_range', stepId: 'sw_tx_step', apiKey: 'tx_power_dbm',
        label: 'Tx Power',
        toSI: v => convertPowerToDBm(v, document.getElementById('txPowerUnit').value)
    },
    'wave': {
        name: 'sweep_wave', rangeId: 'sw_wave_range', stepId: 'sw_wave_step', apiKey: 'wavelength_m',
        label: 'Wavelength',
        toSI: v => convertToNanometers(v, document.getElementById('wavelengthUnit').value) * 1e-9  // nm → m
    },
    'dist': {
        name: 'sweep_dist', rangeId: 'sw_dist_range', stepId: 'sw_dist_step', apiKey: 'distance_m',
        label: 'Distance',
        toSI: v => convertToMeters(v, document.getElementById('distanceUnit').value)
    },
    'txd': {
        name: 'sweep_txd', rangeId: 'sw_txd_range', stepId: 'sw_txd_step', apiKey: 'tx_diameter_m',
        label: 'Tx Diameter',
        toSI: v => convertToMeters(v, document.getElementById('txDiameterUnit').value)
    },
    'rxd': {
        name: 'sweep_rxd', rangeId: 'sw_rxd_range', stepId: 'sw_rxd_step', apiKey: 'rx_diameter_m',
        label: 'Rx Diameter',
        toSI: v => convertToMeters(v, document.getElementById('rxDiameterUnit').value)
    },
    'tx_eff': {
        name: 'sw_tx_eff', rangeId: 'sw_tx_eff_range', stepId: 'sw_tx_eff_step', apiKey: 'tx_efficiency',
        label: 'Tx Efficiency',
        toSI: v => convertToPercent(v, document.getElementById('txEfficiencyUnit').value) / 100  // % → decimal
    },
    'rx_eff': {
        name: 'sw_rx_eff', rangeId: 'sw_rx_eff_range', stepId: 'sw_rx_eff_step', apiKey: 'rx_efficiency',
        label: 'Rx Efficiency',
        toSI: v => convertToPercent(v, document.getElementById('rxEfficiencyUnit').value) / 100
    },
    'sens': {
        name: 'sweep_sens', rangeId: 'sw_sens_range', stepId: 'sw_sens_step', apiKey: 'rx_sensitivity_dbm',
        label: 'Rx Sensitivity',
        toSI: v => convertPowerToDBm(v, document.getElementById('rxSensitivityUnit').value)
    },
    'sys_loss': {
        name: 'sw_sys_loss', rangeId: 'sw_sys_loss_range', stepId: 'sw_sys_loss_step', apiKey: 'implementation_loss_db',
        label: 'System Loss',
        toSI: v => convertLossToDb(v, document.getElementById('sysLossUnit').value)
    },
    'cpl_loss': {
        name: 'sw_cpl_loss', rangeId: 'sw_cpl_loss_range', stepId: 'sw_cpl_loss_step', apiKey: 'coupling_loss_db',
        label: 'Coupling Loss',
        toSI: v => convertLossToDb(v, document.getElementById('cplLossUnit').value)
    },
    'tx_pt': {
        name: 'sw_tx_pt', rangeId: 'sw_tx_pt_range', stepId: 'sw_tx_pt_step',
        // getApiKey is a function here because the key changes based on the pointing mode toggle
        getApiKey: () => document.getElementById('pt_err').checked ? 'tx_pointing_error_rad' : 'tx_pointing_loss_db',
        label: 'Tx Pointing',
        getToSI: () => {
            if (document.getElementById('pt_err').checked) {
                return v => convertAngleToRadians(v, document.getElementById('tx_pt_unit').value);
            }
            return v => convertLossToDb(v, document.getElementById('tx_pt_unit').value);
        }
    },
    'rx_pt': {
        name: 'sw_rx_pt', rangeId: 'sw_rx_pt_range', stepId: 'sw_rx_pt_step',
        getApiKey: () => document.getElementById('pt_err').checked ? 'rx_pointing_error_rad' : 'rx_pointing_loss_db',
        label: 'Rx Pointing',
        getToSI: () => {
            if (document.getElementById('pt_err').checked) {
                return v => convertAngleToRadians(v, document.getElementById('rx_pt_unit').value);
            }
            return v => convertLossToDb(v, document.getElementById('rx_pt_unit').value);
        }
    },
    'lna': {
        name: 'sw_lna', rangeId: 'sw_lna_range', stepId: 'sw_lna_step', apiKey: 'rx_lna_gain_db',
        label: 'Rx LNA Gain',
        toSI: v => parseFloat(v) || 0   // LNA gain is already in dB; just parse as a number
    }
};


// =============================================================================
//  getActiveSweepParams
//  Scans the radio buttons to find which parameters the user has toggled to "Yes".
//  Returns an array of keys (e.g. ['dist'] or ['tx_pt', 'rx_pt']).
// =============================================================================

function getActiveSweepParams() {
    return Object.keys(SWEEP_PARAMS).filter(key => {
        const p = SWEEP_PARAMS[key];
        // document.querySelector finds the checked radio button in this group
        const radio = document.querySelector(`input[name="${p.name}"]:checked`);
        // A radio is "active" (sweep enabled) if its id contains '_yes_' or ends with '_y'
        return radio && (radio.id.includes('_yes_') || radio.id.endsWith('_y'));
    });
}


// =============================================================================
//  collectInputs
//  Reads every input field from the HTML form and returns a single object
//  with all values already converted to the SI units the backend expects.
//  This is the equivalent of reading from a dict/form in Python.
// =============================================================================

function collectInputs() {
    const txEfVal = parseFloat(document.getElementById('txEfficiency').value);   // read as number
    const rxEfVal = parseFloat(document.getElementById('rxEfficiency').value);

    let inputs = {
        // Tx Power: read the number and the selected unit, convert to dBm
        tx_power_dbm: convertPowerToDBm(parseFloat(document.getElementById('txPower').value), document.getElementById('txPowerUnit').value),

        // Efficiency: convert to percent first, then divide by 100 to get 0–1 decimal
        tx_efficiency: convertToPercent(txEfVal, document.getElementById('txEfficiencyUnit').value) / 100,
        rx_efficiency: convertToPercent(rxEfVal, document.getElementById('rxEfficiencyUnit').value) / 100,

        // Rx Sensitivity (optional but always collected; backend ignores it if NaN)
        rx_sensitivity_dbm: convertPowerToDBm(parseFloat(document.getElementById('rxSensitivity').value), document.getElementById('rxSensitivityUnit').value),

        // Wavelength: convert to nm first, then to metres (nm * 1e-9 = m)
        wavelength_m: convertToNanometers(parseFloat(document.getElementById('wavelength').value), document.getElementById('wavelengthUnit').value) * 1e-9,

        // Diameters: convert to metres
        tx_diameter_m: convertToMeters(parseFloat(document.getElementById('txDiameter').value), document.getElementById('txDiameterUnit').value),
        rx_diameter_m: convertToMeters(parseFloat(document.getElementById('rxDiameter').value), document.getElementById('rxDiameterUnit').value),

        // Distance: convert to metres
        distance_m: convertToMeters(parseFloat(document.getElementById('distance').value), document.getElementById('distanceUnit').value),

        // Losses: convert to dB (or leave as-is if already dB)
        implementation_loss_db: convertLossToDb(parseFloat(document.getElementById('sysLoss').value) || 0, document.getElementById('sysLossUnit').value),
        coupling_loss_db: convertLossToDb(parseFloat(document.getElementById('cplLoss').value) || 0, document.getElementById('cplLossUnit').value),

        // LNA gain: always in dB; just parse as number (0 if empty)
        rx_lna_gain_db: parseFloat(document.getElementById('rxLnaGain').value) || 0
    };

    // Pointing: check whether the user is using "error angle" mode or "direct dB loss" mode
    const isPtError = document.getElementById('pt_err').checked;
    const txPtVal  = parseFloat(document.getElementById('txPointing').value) || 0;
    const rxPtVal  = parseFloat(document.getElementById('rxPointing').value) || 0;
    const txPtUnit = document.getElementById('tx_pt_unit').value;
    const rxPtUnit = document.getElementById('rx_pt_unit').value;

    if (isPtError) {
        // Angle mode: convert angle to radians; backend will compute the loss
        inputs.tx_pointing_error_rad = convertAngleToRadians(txPtVal, txPtUnit);
        inputs.rx_pointing_error_rad = convertAngleToRadians(rxPtVal, rxPtUnit);
        inputs.tx_pointing_loss_db   = 0;   // not used when error angle is provided
        inputs.rx_pointing_loss_db   = 0;
    } else {
        // Direct loss mode: send dB loss directly; no angle computation needed
        inputs.tx_pointing_loss_db   = convertLossToDb(txPtVal, txPtUnit);
        inputs.rx_pointing_loss_db   = convertLossToDb(rxPtVal, rxPtUnit);
        inputs.tx_pointing_error_rad = null;   // null = not provided
        inputs.rx_pointing_error_rad = null;
    }

    return inputs;
}


// =============================================================================
//  displayResults
//  Takes the flat `outputs` object from the backend response and updates
//  every visible result field in the HTML with the calculated values.
//  Also applies the correct display unit (dBm vs mW) based on the dropdowns.
// =============================================================================

function displayResults(outputs) {
    // --- Received Power ---
    let rxPowerUnit = document.getElementById('res_rx_power_unit').value;
    // Use LNA-amplified power if available; fall back to non-LNA power
    let rxPowerVal = outputs.received_power_lna_dbm !== undefined ? outputs.received_power_lna_dbm : outputs.received_power_dbm;
    if (rxPowerUnit === 'mW') {
        document.getElementById('res_rx_power').innerText = formatPower(dBmToMW(rxPowerVal));
    } else {
        document.getElementById('res_rx_power').innerText = rxPowerVal.toFixed(2);  // 2 decimal places
    }

    // --- Link Margin ---
    let lmUnit = document.getElementById('res_link_margin_unit').value;
    if (lmUnit === 'mW') {
        document.getElementById('res_link_margin').innerText = dBmToMW(outputs.link_margin_db).toFixed(4);
    } else {
        document.getElementById('res_link_margin').innerText = outputs.link_margin_db.toFixed(2);
    }

    // Colour the link margin green (positive = viable) or red (negative = not viable)
    if (outputs.link_margin_db > 0) {
        document.getElementById('res_link_margin').style.color = 'darkgreen';
    } else {
        document.getElementById('res_link_margin').style.color = 'darkred';
    }

    // --- All other result fields: just write the formatted value ---
    document.getElementById('res_tx_gain').innerText      = outputs.tx_gain_db.toFixed(2) + ' dB';
    document.getElementById('res_rx_gain').innerText      = outputs.rx_gain_db.toFixed(2) + ' dB';
    document.getElementById('res_tx_eff_loss').innerText  = (outputs.tx_efficiency_loss_db || 0).toFixed(2) + ' dB';
    document.getElementById('res_rx_eff_loss').innerText  = (outputs.rx_efficiency_loss_db || 0).toFixed(2) + ' dB';
    document.getElementById('res_path_loss').innerText    = outputs.path_loss_db.toFixed(2) + ' dB';

    // "Other loss" combines implementation loss and coupling loss for one compact display
    document.getElementById('res_other_loss').innerText   = ((outputs.implementation_loss_db || 0) + (outputs.coupling_loss_db || 0)).toFixed(2) + ' dB';
    // Note: impl_loss_db is what the backend calls implementation_loss_db in outputs
    document.getElementById('res_tx_pl_loss').innerText   = (outputs.tx_pointing_loss_db || 0).toFixed(2) + ' dB';
    document.getElementById('res_rx_pl_loss').innerText   = (outputs.rx_pointing_loss_db || 0).toFixed(2) + ' dB';
}


// =============================================================================
//  formatPower
//  Smart formatter for milliwatt values that are potentially very tiny
//  (e.g. received optical power might be femtowatts = 1e-15 W = 1e-12 mW).
//  Uses scientific notation for very small/large values, fixed decimal otherwise.
// =============================================================================

function formatPower(mw) {
    if (mw === 0) return '0.000000';
    if (Math.abs(mw) < 0.0001) return mw.toExponential(4);  // e.g. "1.2345e-7"
    return mw.toFixed(6);                                     // e.g. "0.012345"
}


// =============================================================================
//  validateInputs
//  Client-side (browser-side) validation of the input fields BEFORE sending
//  anything to the backend.  Shows a human-readable error in an alert dialog.
//
//  activeSweeps: array of sweep keys currently active (e.g. ['dist'])
//  When a parameter is being swept, we validate the sweep range fields instead
//  of the single-value input field.
// =============================================================================

function validateInputs(activeSweeps = []) {
    const getFloat = id => parseFloat(document.getElementById(id).value);

    // 1. Tx Power
    if (!activeSweeps.includes('tx')) {
        const val = getFloat('txPower');
        const unit = document.getElementById('txPowerUnit').value;
        if (isNaN(val)) throw new Error("Tx Power must be a valid number.");
        if ((unit === 'mW' || unit === 'W') && val <= 0) {
            throw new Error("Tx Power must be strictly positive when using mW or W.");
        }
    } else {
        // In sweep mode: validate the range string instead
        const rangeStr = document.getElementById('sw_tx_range').value || "";
        const parts = rangeStr.split('-');
        if (parts.length >= 2) {
            const min = parseFloat(parts[0].trim());
            const max = parseFloat(parts[1].trim());
            const unit = document.getElementById('txPowerUnit').value;
            if ((unit === 'mW' || unit === 'W') && (min <= 0 || max <= 0)) {
                throw new Error("Tx Power sweep range values must be strictly positive when using mW or W.");
            }
        }
    }

    // 2. Wavelength
    if (!activeSweeps.includes('wave')) {
        const val = getFloat('wavelength');
        if (isNaN(val) || val <= 0) throw new Error("Wavelength must be a positive number.");
    } else {
        const rangeStr = document.getElementById('sw_wave_range').value || "";
        const parts = rangeStr.split('-');
        if (parts.length >= 2) {
            const min = parseFloat(parts[0].trim());
            const max = parseFloat(parts[1].trim());
            if (min <= 0 || max <= 0) throw new Error("Wavelength sweep range values must be strictly positive.");
        }
    }

    // 3. Distance
    if (!activeSweeps.includes('dist')) {
        const val = getFloat('distance');
        if (isNaN(val) || val <= 0) throw new Error("Distance must be a positive number.");
    } else {
        const rangeStr = document.getElementById('sw_dist_range').value || "";
        const parts = rangeStr.split('-');
        if (parts.length >= 2) {
            const min = parseFloat(parts[0].trim());
            const max = parseFloat(parts[1].trim());
            if (min <= 0 || max <= 0) throw new Error("Distance sweep range values must be strictly positive.");
        }
    }

    // 4. Tx Diameter
    if (!activeSweeps.includes('txd')) {
        const val = getFloat('txDiameter');
        if (isNaN(val) || val <= 0) throw new Error("Tx Diameter must be a positive number.");
    } else {
        const rangeStr = document.getElementById('sw_txd_range').value || "";
        const parts = rangeStr.split('-');
        if (parts.length >= 2) {
            const min = parseFloat(parts[0].trim());
            const max = parseFloat(parts[1].trim());
            if (min <= 0 || max <= 0) throw new Error("Tx Diameter sweep range values must be strictly positive.");
        }
    }

    // 5. Rx Diameter
    if (!activeSweeps.includes('rxd')) {
        const val = getFloat('rxDiameter');
        if (isNaN(val) || val <= 0) throw new Error("Rx Diameter must be a positive number.");
    } else {
        const rangeStr = document.getElementById('sw_rxd_range').value || "";
        const parts = rangeStr.split('-');
        if (parts.length >= 2) {
            const min = parseFloat(parts[0].trim());
            const max = parseFloat(parts[1].trim());
            if (min <= 0 || max <= 0) throw new Error("Rx Diameter sweep range values must be strictly positive.");
        }
    }

    // 6. Tx Efficiency
    if (!activeSweeps.includes('tx_eff')) {
        const val = getFloat('txEfficiency');
        const unit = document.getElementById('txEfficiencyUnit').value;
        if (isNaN(val) || val <= 0) throw new Error("Tx Efficiency must be a positive number.");
        if (unit === '%' && val > 100)  throw new Error("Tx Efficiency cannot exceed 100%.");
        if (unit === 'dec' && val > 1)  throw new Error("Tx Efficiency cannot exceed 1.0 in decimal mode.");
    } else {
        const rangeStr = document.getElementById('sw_tx_eff_range').value || "";
        const parts = rangeStr.split('-');
        if (parts.length >= 2) {
            const min = parseFloat(parts[0].trim());
            const max = parseFloat(parts[1].trim());
            const unit = document.getElementById('txEfficiencyUnit').value;
            if (min <= 0 || max <= 0)             throw new Error("Tx Efficiency sweep range values must be strictly positive.");
            if (unit === '%' && (min > 100 || max > 100)) throw new Error("Tx Efficiency sweep range values cannot exceed 100%.");
            if (unit === 'dec' && (min > 1 || max > 1))   throw new Error("Tx Efficiency sweep range values cannot exceed 1.0 in decimal mode.");
        }
    }

    // 7. Rx Efficiency
    if (!activeSweeps.includes('rx_eff')) {
        const val = getFloat('rxEfficiency');
        const unit = document.getElementById('rxEfficiencyUnit').value;
        if (isNaN(val) || val <= 0) throw new Error("Rx Efficiency must be a positive number.");
        if (unit === '%' && val > 100)  throw new Error("Rx Efficiency cannot exceed 100%.");
        if (unit === 'dec' && val > 1)  throw new Error("Rx Efficiency cannot exceed 1.0 in decimal mode.");
    } else {
        const rangeStr = document.getElementById('sw_rx_eff_range').value || "";
        const parts = rangeStr.split('-');
        if (parts.length >= 2) {
            const min = parseFloat(parts[0].trim());
            const max = parseFloat(parts[1].trim());
            const unit = document.getElementById('rxEfficiencyUnit').value;
            if (min <= 0 || max <= 0)             throw new Error("Rx Efficiency sweep range values must be strictly positive.");
            if (unit === '%' && (min > 100 || max > 100)) throw new Error("Rx Efficiency sweep range values cannot exceed 100%.");
            if (unit === 'dec' && (min > 1 || max > 1))   throw new Error("Rx Efficiency sweep range values cannot exceed 1.0 in decimal mode.");
        }
    }

    // 8. Rx Sensitivity
    if (!activeSweeps.includes('sens')) {
        const val = getFloat('rxSensitivity');
        const unit = document.getElementById('rxSensitivityUnit').value;
        if (isNaN(val)) throw new Error("Rx Sensitivity must be a valid number.");
        if (unit === 'mW' && val <= 0) throw new Error("Rx Sensitivity must be strictly positive when using mW.");
    } else {
        const rangeStr = document.getElementById('sw_sens_range').value || "";
        const parts = rangeStr.split('-');
        if (parts.length >= 2) {
            const min = parseFloat(parts[0].trim());
            const max = parseFloat(parts[1].trim());
            const unit = document.getElementById('rxSensitivityUnit').value;
            if (unit === 'mW' && (min <= 0 || max <= 0)) throw new Error("Rx Sensitivity sweep range values must be strictly positive when using mW.");
        }
    }

    // 9. Non-negative fields: Loss values and pointing (must be ≥ 0)
    const nonNegativeFields = [
        { id: 'sysLoss',    label: 'System Loss',   sweepKey: 'sys_loss', rangeId: 'sw_sys_loss_range' },
        { id: 'cplLoss',    label: 'Coupling Loss',  sweepKey: 'cpl_loss', rangeId: 'sw_cpl_loss_range' },
        { id: 'txPointing', label: 'Tx Pointing',    sweepKey: 'tx_pt',    rangeId: 'sw_tx_pt_range' },
        { id: 'rxPointing', label: 'Rx Pointing',    sweepKey: 'rx_pt',    rangeId: 'sw_rx_pt_range' },
        { id: 'rxLnaGain',  label: 'Rx LNA Gain',    sweepKey: 'lna',      rangeId: 'sw_lna_range' }
    ];

    for (const f of nonNegativeFields) {
        if (!activeSweeps.includes(f.sweepKey)) {
            const val = getFloat(f.id);
            if (isNaN(val) || val < 0) throw new Error(`${f.label} must be 0 or a positive number.`);
        } else {
            const rangeStr = document.getElementById(f.rangeId).value || "";
            const parts = rangeStr.split('-');
            if (parts.length >= 2) {
                const min = parseFloat(parts[0].trim());
                const max = parseFloat(parts[1].trim());
                if (min < 0 || max < 0) throw new Error(`${f.label} sweep range values must be non-negative.`);
            }
        }
    }
}


// =============================================================================
//  handleCalculateClick
//  Called when the RUN button is clicked.
//  Decides whether to run a single calculation or a sweep.
// =============================================================================

function handleCalculateClick() {
    const activeSweeps = getActiveSweepParams();
    if (activeSweeps.length > 0) {
        runSweep();           // at least one parameter has "Yes" toggled → sweep mode
    } else {
        calculateLinkBudget(); // no sweep → single calculation
    }
}


// =============================================================================
//  calculateLinkBudget  (single-point calculation)
//  Sends the current inputs to /api/calculate and displays the result.
// =============================================================================

async function calculateLinkBudget() {
    const btn = document.getElementById('btnRun');
    btn.innerText = 'WAIT...';  // visually disable and show feedback
    btn.disabled = true;

    try {
        validateInputs([]);     // validate single-point inputs (no active sweeps)
        const inputs = collectInputs();  // collect and convert all input field values

        console.log("Sending payload to backend v4:", inputs);  // log for debugging

        // POST to /api/calculate; await means we pause here until the backend responds
        const response = await fetch(`${API_BASE_URL}/api/calculate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(inputs)   // send inputs as JSON text
        });

        if (!response.ok) {
            // Parse the error detail from the backend's error response
            const err = await response.json().catch(() => ({}));
            let errMsg = 'Calculation failed';
            if (err.detail) {
                if (typeof err.detail === 'string')      errMsg = err.detail;
                else if (Array.isArray(err.detail))      errMsg = err.detail.map(e => e.msg).join(', ');
                else                                     errMsg = JSON.stringify(err.detail);
            }
            throw new Error(errMsg);
        }

        const data = await response.json();   // parse the JSON response body

        currentCalculationData = data.outputs;  // save for unit-change re-renders
        currentSweepResults = null;              // clear any old sweep data

        if (sweepChartInstance) {
            sweepChartInstance.destroy();   // remove any previous chart
            sweepChartInstance = null;
        }

        displayResults(data.outputs);   // update the results panel in the UI
        hideGraph();                    // hide the chart area (no sweep, no graph)

    } catch (err) {
        alert(err.message);   // show error to user
    } finally {
        // Always re-enable the button, whether calculation succeeded or failed
        btn.innerText = 'RUN';
        btn.disabled = false;
    }
}


// =============================================================================
//  runSweep  (parameter sweep)
//  Sends inputs + sweep configuration to /api/sweep.
//  The backend runs the calculation repeatedly for each step value and
//  returns all results as a list.
// =============================================================================

async function runSweep() {
    const activeSweeps = getActiveSweepParams();
    if (activeSweeps.length === 0) return;

    // We only support sweeping one primary parameter at a time.
    // Exception: Tx Pointing and Rx Pointing can be swept simultaneously.
    const primaryKey   = activeSweeps[0];
    const secondaryKey = activeSweeps.length > 1 ? activeSweeps[1] : null;

    if (secondaryKey &&
        !(primaryKey === 'tx_pt' && secondaryKey === 'rx_pt') &&
        !(primaryKey === 'rx_pt' && secondaryKey === 'tx_pt')) {
        alert("Only Tx Pointing and Rx Pointing can be swept simultaneously.");
        return;
    }

    const btn = document.getElementById('btnRun');
    btn.innerText = 'WAIT...';
    btn.disabled = true;

    try {
        validateInputs(activeSweeps);    // validate inputs including the sweep range fields
        const baseInputs = collectInputs();  // collect the base (non-swept) input values

        // Get the SWEEP_PARAMS config for the primary parameter
        const info     = SWEEP_PARAMS[primaryKey];
        const rangeStr = document.getElementById(info.rangeId).value || "";
        const parts    = rangeStr.split('-');
        if (parts.length < 2) throw new Error(`Invalid range format for ${info.label}, expected format 'min - max' e.g '1 - 10'.`);

        const rawMin = parseFloat(parts[0].trim());  // min in display units
        const rawMax = parseFloat(parts[1].trim());  // max in display units
        const steps  = parseInt(document.getElementById(info.stepId).value);  // number of steps

        if (isNaN(rawMin) || isNaN(rawMax) || isNaN(steps) || steps < 1) {
            throw new Error('Please fill in valid Range and Step values for the sweep.');
        }

        // Get the SI conversion function and API key for the primary parameter.
        // Some params use getter functions (tx_pt, rx_pt) instead of direct values.
        const toSI   = info.getToSI  ? info.getToSI()  : info.toSI;
        const apiKey = info.getApiKey ? info.getApiKey() : info.apiKey;

        // Set a dummy value for the swept parameter in baseInputs so the
        // Pydantic model on the backend can validate it as "present".
        baseInputs[apiKey] = 1;

        // Build the sweep request payload
        const sweepReq = {
            base_inputs:  baseInputs,
            sweep_param:  apiKey,
            sweep_min:    toSI(rawMin),   // convert min display value → SI unit
            sweep_max:    toSI(rawMax),   // convert max display value → SI unit
            sweep_steps:  steps
        };

        // Add secondary sweep parameter if both pointing params are being swept
        if (secondaryKey) {
            const info2     = SWEEP_PARAMS[secondaryKey];
            const rangeStr2 = document.getElementById(info2.rangeId).value || "";
            const parts2    = rangeStr2.split('-');
            if (parts2.length < 2) throw new Error(`Invalid range format for ${info2.label}.`);

            const rawMin2 = parseFloat(parts2[0].trim());
            const rawMax2 = parseFloat(parts2[1].trim());
            const steps2  = parseInt(document.getElementById(info2.stepId).value);

            if (isNaN(rawMin2) || isNaN(rawMax2) || isNaN(steps2) || steps2 < 1) {
                throw new Error('Please fill in valid Range and Step values for the second sweep parameter.');
            }
            if (steps !== steps2) {
                throw new Error('Hey! If you want to sweep both Tx and Rx Pointing at the same time, the number of steps must match exactly.');
            }

            const toSI2   = info2.getToSI  ? info2.getToSI()  : info2.toSI;
            const apiKey2 = info2.getApiKey ? info2.getApiKey() : info2.apiKey;

            baseInputs[apiKey2] = 1;  // dummy value for model validation

            sweepReq.sweep_param2 = apiKey2;
            sweepReq.sweep_min2   = toSI2(rawMin2);
            sweepReq.sweep_max2   = toSI2(rawMax2);
        }

        // Send the sweep request to the backend
        const response = await fetch(`${API_BASE_URL}/api/sweep`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(sweepReq)
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            let errMsg = 'Sweep API call failed';
            if (err.detail) {
                if (typeof err.detail === 'string')  errMsg = err.detail;
                else if (Array.isArray(err.detail))  errMsg = err.detail.map(e => e.msg).join(', ');
                else                                 errMsg = JSON.stringify(err.detail);
            }
            throw new Error(errMsg);
        }

        const data = await response.json();

        // Store results globally for chart drawing, table, PDF export, etc.
        currentSweepResults   = data.results;     // array of {sweep_value, outputs}
        currentSweepParamKey  = primaryKey;
        currentSweepLabel     = info.label;

        // Also store the first iteration's outputs as the "static" single-point result
        // so that PDF export has a reference calculation even in sweep mode.
        currentCalculationData = data.results[0].outputs;

        updateXAxisOptionText();           // update the x-axis dropdown label to match swept param
        displayResults(data.results[0].outputs);   // show the first sweep point in the results panel
        updateIterationSweepInfo();        // show "Distance: 100 m" style info label
        hideGraph();                       // start with graph hidden (user clicks Plot Graph to show)
        drawTable(data.results, info.label);  // auto-populate the data table

    } catch (err) {
        alert(err.message);
    } finally {
        btn.innerText = 'RUN';
        btn.disabled = false;
    }
}


// =============================================================================
//  updateIterationSweepInfo
//  Updates the small text label that shows which sweep value is currently
//  being displayed in the results panel (e.g. "Distance: 500.00 m").
// =============================================================================

function updateIterationSweepInfo() {
    const infoSpan = document.getElementById('iteration_sweep_info');
    if (!infoSpan) return;

    if (!currentSweepResults || currentSweepResults.length === 0) {
        infoSpan.textContent = '';
        return;
    }

    // Read the currently selected iteration from the dropdown (1-indexed in UI, 0-indexed in array)
    const idx   = parseInt(document.getElementById('iteration_dropdown').value) - 1;
    const point = currentSweepResults[idx];
    if (!point) { infoSpan.textContent = ''; return; }

    // Convert the raw SI sweep value back to the user's display unit
    let displayValue = getDisplaySweepValue(point.sweep_value, currentSweepParamKey);
    let unit = '';

    // Look up what unit the user has selected for the swept parameter
    if      (currentSweepParamKey === 'tx')       unit = document.getElementById('txPowerUnit').value;
    else if (currentSweepParamKey === 'wave')     unit = document.getElementById('wavelengthUnit').value;
    else if (currentSweepParamKey === 'dist')     unit = document.getElementById('distanceUnit').value;
    else if (currentSweepParamKey === 'txd')      unit = document.getElementById('txDiameterUnit').value;
    else if (currentSweepParamKey === 'rxd')      unit = document.getElementById('rxDiameterUnit').value;
    else if (currentSweepParamKey === 'tx_eff')   unit = document.getElementById('txEfficiencyUnit').value;
    else if (currentSweepParamKey === 'rx_eff')   unit = document.getElementById('rxEfficiencyUnit').value;
    else if (currentSweepParamKey === 'sens')     unit = document.getElementById('rxSensitivityUnit').value;
    else if (currentSweepParamKey === 'sys_loss') unit = document.getElementById('sysLossUnit').value;
    else if (currentSweepParamKey === 'cpl_loss') unit = document.getElementById('cplLossUnit').value;
    else if (currentSweepParamKey === 'tx_pt') {
        const isError = document.getElementById('pt_err').checked;
        unit = isError ? document.getElementById('tx_pt_unit').value : 'dB';
    }
    else if (currentSweepParamKey === 'rx_pt') {
        const isError = document.getElementById('pt_err').checked;
        unit = isError ? document.getElementById('rx_pt_unit').value : 'dB';
    }
    else if (currentSweepParamKey === 'lna') unit = 'dB';

    infoSpan.textContent = `${currentSweepLabel}: ${displayValue.toFixed(2)} ${unit}`;
}


// =============================================================================
//  handleIterationChange
//  Called when the user changes the iteration dropdown to a different sweep point.
//  Updates the results panel and the sweep info label.
// =============================================================================

function handleIterationChange() {
    if (!currentSweepResults) return;
    const idx = parseInt(document.getElementById('iteration_dropdown').value) - 1;
    if (currentSweepResults[idx]) {
        displayResults(currentSweepResults[idx].outputs);  // show this iteration's results
        updateIterationSweepInfo();                         // update the "Distance: X m" label
    }
}


// =============================================================================
//  hideGraph
//  Hides the Chart.js canvas and shows the "no data" placeholder text/labels
//  that appear before the user clicks "Plot Graph".
// =============================================================================

function hideGraph() {
    document.getElementById('sweepChart').style.display       = 'none';
    document.getElementById('graphAxisX').style.display       = 'block';
    document.getElementById('graphAxisY').style.display       = 'block';
    document.getElementById('graphPlaceholderText').style.display = 'block';
}


// =============================================================================
//  getSweepAxisLabel
//  Returns a human-readable label for the x-axis of the chart.
//  If the x-axis is the active sweep parameter, builds a label with units,
//  e.g. "Active Sweep Parameter (Distance (km))".
//  Otherwise returns the default label from the dropdown option text.
// =============================================================================

function getSweepAxisLabel(xAxisKey, defaultLabel) {
    if (xAxisKey === 'sweep_value' && currentSweepParamKey) {
        let unit = '';
        if      (currentSweepParamKey === 'tx')       unit = document.getElementById('txPowerUnit').value;
        else if (currentSweepParamKey === 'wave')     unit = document.getElementById('wavelengthUnit').value;
        else if (currentSweepParamKey === 'dist')     unit = document.getElementById('distanceUnit').value;
        else if (currentSweepParamKey === 'txd')      unit = document.getElementById('txDiameterUnit').value;
        else if (currentSweepParamKey === 'rxd')      unit = document.getElementById('rxDiameterUnit').value;
        else if (currentSweepParamKey === 'tx_eff') {
            unit = document.getElementById('txEfficiencyUnit').value;
            if (unit === 'dec') unit = 'linear';  // 'dec' isn't a great label, 'linear' is clearer
        }
        else if (currentSweepParamKey === 'rx_eff') {
            unit = document.getElementById('rxEfficiencyUnit').value;
            if (unit === 'dec') unit = 'linear';
        }
        else if (currentSweepParamKey === 'sens')     unit = document.getElementById('rxSensitivityUnit').value;
        else if (currentSweepParamKey === 'sys_loss') unit = document.getElementById('sysLossUnit').value;
        else if (currentSweepParamKey === 'cpl_loss') unit = document.getElementById('cplLossUnit').value;
        else if (currentSweepParamKey === 'tx_pt') {
            const isError = document.getElementById('pt_err').checked;
            unit = isError ? document.getElementById('tx_pt_unit').value : 'dB';
        }
        else if (currentSweepParamKey === 'rx_pt') {
            const isError = document.getElementById('pt_err').checked;
            unit = isError ? document.getElementById('rx_pt_unit').value : 'dB';
        }
        else if (currentSweepParamKey === 'lna') unit = 'dB';

        return `Active Sweep Parameter (${currentSweepLabel}${unit ? ' (' + unit + ')' : ''})`;
    }
    return defaultLabel;
}


// =============================================================================
//  updateXAxisOptionText
//  Updates the text of the first option in the x-axis dropdown to reflect
//  the currently swept parameter (e.g. changes "Active Sweep Parameter" to
//  "Active Sweep Parameter (Distance (km))").
// =============================================================================

function updateXAxisOptionText() {
    const xAxisSelect = document.getElementById('plot_x_axis');
    if (!xAxisSelect) return;
    const label = getSweepAxisLabel('sweep_value', 'Active Sweep Parameter');
    xAxisSelect.options[0].text = label;
}


// =============================================================================
//  drawChart
//  Uses Chart.js (a JavaScript charting library loaded in the HTML) to draw
//  a line chart from the sweep results.
//  Supports two y-axes simultaneously (left and right) for overlay comparison.
// =============================================================================

function drawChart(results, paramLabel) {
    // Show the sweep graph modal (the popup window that contains the chart)
    document.getElementById('sweepGraphModal').style.display = 'flex';
    document.getElementById('sweepChart').style.display      = 'block';
    // Hide the "no data" placeholder elements
    document.getElementById('graphAxisX').style.display      = 'none';
    document.getElementById('graphAxisY').style.display      = 'none';
    document.getElementById('graphPlaceholderText').style.display = 'none';

    // Read what the user selected for x-axis and y-axis from the dropdowns
    const xAxisSelect  = document.getElementById('plot_x_axis');
    const xAxisKey     = xAxisSelect.value;
    const xAxisLabel   = getSweepAxisLabel(xAxisKey, xAxisSelect.options[xAxisSelect.selectedIndex].text);

    const yAxisSelect  = document.getElementById('plot_y_axis');
    const yAxisKey     = yAxisSelect.value;
    const yAxisLabel   = yAxisSelect.options[yAxisSelect.selectedIndex].text;

    const yAxisRightSelect = document.getElementById('plot_y_axis_right');
    const yAxisRightKey    = yAxisRightSelect ? yAxisRightSelect.value : 'none';
    const yAxisRightLabel  = yAxisRightSelect && yAxisRightKey !== 'none' ? yAxisRightSelect.options[yAxisRightSelect.selectedIndex].text : '';

    // Build the array of x-axis labels (one per sweep point)
    let labels = [];
    if (xAxisKey === 'sweep_value') {
        // Use the raw sweep parameter value (converted back to display unit)
        labels = results.map(r => {
            let displayValue = getDisplaySweepValue(r.sweep_value, currentSweepParamKey);
            return displayValue.toFixed(2);
        });
    } else {
        // Use a calculated output value as the x-axis (e.g. path loss vs received power)
        labels = results.map(r => {
            const val = r.outputs[xAxisKey];
            return val !== undefined && val !== null ? val.toFixed(2) : '';
        });
    }

    // Extract the primary y-axis data (one value per sweep point)
    const yData = results.map(r => r.outputs[yAxisKey]);

    // Build the Chart.js datasets array.
    // A "dataset" is one line on the chart.
    const datasets = [
        {
            label:           yAxisLabel,
            data:            yData,
            borderColor:     '#000080',       // navy blue line
            backgroundColor: 'transparent',
            borderWidth:     2,
            tension:         0.2,             // slight curve (0 = straight lines)
            yAxisID:         'y'              // bind to the left y-axis
        }
    ];

    // Chart.js "scales" config defines the axes
    const scales = {
        x: { title: { display: true, text: xAxisLabel } },
        y: { type: 'linear', position: 'left', title: { display: true, text: yAxisLabel } }
    };

    // If the user selected a right y-axis, add a second dataset and second y-axis scale
    if (yAxisRightKey !== 'none') {
        datasets.push({
            label:           yAxisRightLabel,
            data:            results.map(r => r.outputs[yAxisRightKey]),
            borderColor:     '#008000',       // green line
            backgroundColor: 'transparent',
            borderWidth:     2,
            tension:         0.2,
            yAxisID:         'y2'             // bind to the right y-axis
        });

        scales.y2 = {
            type:     'linear',
            position: 'right',
            grid:     { drawOnChartArea: false },  // don't draw right-axis grid lines over the chart
            title:    { display: true, text: yAxisRightLabel }
        };
    }

    // Destroy any existing chart before creating a new one
    // (Chart.js doesn't allow two charts on the same canvas)
    if (sweepChartInstance) {
        sweepChartInstance.destroy();
    }

    // Create the Chart.js line chart on the <canvas id="sweepChart"> element
    const ctx = document.getElementById('sweepChart').getContext('2d');
    sweepChartInstance = new Chart(ctx, {
        type: 'line',
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,  // allows the canvas to fill its container height
            scales
        }
    });
}


// =============================================================================
//  drawTable
//  Populates the sweep data table (the one inside the "Plot Table" modal).
//  Each row represents one sweep point; columns match the axis dropdowns.
//  Clicking a row selects that iteration and displays its results.
// =============================================================================

function drawTable(results, paramLabel) {
    // Read the current axis selections (same logic as drawChart)
    const xAxisSelect  = document.getElementById('plot_x_axis');
    const xAxisKey     = xAxisSelect.value;
    const xAxisLabel   = getSweepAxisLabel(xAxisKey, xAxisSelect.options[xAxisSelect.selectedIndex].text);

    const yAxisSelect  = document.getElementById('plot_y_axis');
    const yAxisKey     = yAxisSelect.value;
    const yAxisLabel   = yAxisSelect.options[yAxisSelect.selectedIndex].text;

    const yAxisRightSelect = document.getElementById('plot_y_axis_right');
    const yAxisRightKey    = yAxisRightSelect ? yAxisRightSelect.value : 'none';
    const yAxisRightLabel  = yAxisRightSelect && yAxisRightKey !== 'none' ? yAxisRightSelect.options[yAxisRightSelect.selectedIndex].text : '';

    // Update the column header cells
    document.getElementById('tableHeaderSweepParam').textContent = xAxisLabel;
    document.getElementById('tableHeaderCol2').textContent = yAxisLabel;

    const col2RightHeader = document.getElementById('tableHeaderCol2Right');
    const showCol2Right = yAxisRightKey !== 'none';
    if (col2RightHeader) {
        col2RightHeader.textContent = yAxisRightLabel;
        col2RightHeader.style.display = showCol2Right ? '' : 'none';  // hide if no right axis selected
    }

    // Decide which extra columns to show based on what's already on the axes
    // (avoid duplicating a column that's already the primary y-axis)
    const col3Header = document.getElementById('tableHeaderCol3');  // Received Power
    const col4Header = document.getElementById('tableHeaderCol4');  // Path Loss
    const col5Header = document.getElementById('tableHeaderCol5');  // Link Margin

    const showCol3 = yAxisKey !== 'received_power_lna_dbm' && yAxisRightKey !== 'received_power_lna_dbm';
    const showCol4 = yAxisKey !== 'path_loss_db'           && yAxisRightKey !== 'path_loss_db';
    const showCol5 = yAxisKey !== 'link_margin_db'         && yAxisRightKey !== 'link_margin_db';

    col3Header.style.display = showCol3 ? '' : 'none';
    col4Header.style.display = showCol4 ? '' : 'none';
    col5Header.style.display = showCol5 ? '' : 'none';

    // Clear any existing table rows and rebuild from scratch
    const tBody = document.getElementById('sweepTableBody');
    tBody.innerHTML = '';

    results.forEach((point, index) => {
        const row = document.createElement('tr');  // create a new table row element
        row.style.borderBottom = '1px solid #d0d0d0';
        row.style.background   = index % 2 === 0 ? '#ffffff' : '#f8f8f8';  // alternating row colours

        // Build the x-axis cell value
        let xValDisp = '';
        if (xAxisKey === 'sweep_value') {
            let displayValue = getDisplaySweepValue(point.sweep_value, currentSweepParamKey);
            xValDisp = displayValue.toFixed(4);
        } else {
            const v = point.outputs[xAxisKey];
            xValDisp = (v !== undefined && v !== null) ? v.toFixed(4) : '—';
        }

        // Build each cell value
        const yVal         = point.outputs[yAxisKey];
        const yValDisp     = (yVal !== undefined && yVal !== null) ? yVal.toFixed(2) : '—';

        const yValRight    = yAxisRightKey !== 'none' ? point.outputs[yAxisRightKey] : null;
        const yValRightDisp = (yValRight !== undefined && yValRight !== null) ? yValRight.toFixed(2) : '—';

        const linkMargin   = point.outputs.link_margin_db;
        const linkMarginDisp = (linkMargin !== undefined && linkMargin !== null) ? linkMargin.toFixed(2) : '—';

        // Use LNA-boosted power if available, otherwise raw received power
        const rxPwr = point.outputs.received_power_lna_dbm !== undefined ? point.outputs.received_power_lna_dbm : point.outputs.received_power_dbm;
        const rxPwrDisp = (rxPwr !== undefined && rxPwr !== null) ? rxPwr.toFixed(2) : '—';

        const pathLoss     = point.outputs.path_loss_db;
        const pathLossDisp = (pathLoss !== undefined && pathLoss !== null) ? pathLoss.toFixed(2) : '—';

        const viable       = point.outputs.link_viable;
        const viableStr    = viable === true ? 'Yes' : viable === false ? 'No' : '—';
        const viableColor  = viable === true ? 'green' : viable === false ? 'red' : 'inherit';

        // Conditionally build the optional cells (only include if column is visible)
        const yValRightTd    = showCol2Right ? `<td style="text-align: right; padding: 4px; border: 1px solid #808080;">${yValRightDisp}</td>` : '';
        const linkMarginTd   = showCol5      ? `<td style="text-align: right; padding: 4px; border: 1px solid #808080;">${linkMarginDisp}</td>` : '';
        const rxPwrTd        = showCol3      ? `<td style="text-align: right; padding: 4px; border: 1px solid #808080;">${rxPwrDisp}</td>` : '';
        const pathLossTd     = showCol4      ? `<td style="text-align: right; padding: 4px; border: 1px solid #808080;">${pathLossDisp}</td>` : '';

        // Build the row's inner HTML using a template literal (like Python's f-strings)
        row.innerHTML = `
            <td style="padding: 4px; border: 1px solid #808080;">${xValDisp}</td>
            <td style="text-align: right; padding: 4px; border: 1px solid #808080;">${yValDisp}</td>
            ${yValRightTd}
            ${linkMarginTd}
            ${rxPwrTd}
            ${pathLossTd}
            <td style="text-align: center; padding: 4px; border: 1px solid #808080; color: ${viableColor}; font-weight: bold;">
                ${viableStr}
            </td>
        `;

        // Make each row clickable: clicking it selects that iteration in the dropdown
        // and closes the table modal so the user sees the results panel update.
        row.style.cursor = 'pointer';
        row.title = "Click to load this iteration";
        row.addEventListener('click', () => {
            const iterDrop = document.getElementById('iteration_dropdown');
            if (iterDrop) {
                iterDrop.value = index + 1;   // +1 because dropdown is 1-indexed
                handleIterationChange();       // update results panel to show this iteration
            }
            document.getElementById('sweepTableModal').style.display = 'none';  // close modal
        });

        tBody.appendChild(row);   // add the completed row to the table body
    });
}
