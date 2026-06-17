# LBsim: Optical Link Budget Estimation Tool

LBsim is a deterministic, open-source optical link budget analysis tool for Optical Inter-Satellite Links (OISLs). It provides researchers with a lightweight, Python-based alternative to heavy commercial simulation platforms.

## Validation
LBsim has been validated against OptiSystem across 100+ randomized LEO-class configurations, demonstrating near-identical tracking:
- **Mean Absolute Error (MAE):** 0.018 dB
- **Mean Squared Error (MSE):** 3.334 × 10⁻⁴ dB²

## Getting Started

### Option 1: Download Executable (No Python Required)
1. Go to the **Releases** tab on GitHub.
2. Download `LBsim.exe`.
3. Double-click to run.

> [!WARNING]  
> **Windows Defender SmartScreen** may flag the `.exe` when you first run it because it is an unsigned file. This is a known false positive. To bypass it, simply click **"More info"** and then **"Run anyway"**.


### Option 2: Run from Source
1. Clone the repository:
   ```bash
   git clone https://github.com/yourusername/LBsim.git
   cd LBsim
   ```

2. Set up a virtual environment and install dependencies:
   ```bash
   python -m venv venv
   .\venv\Scripts\activate  # Windows
   # source venv/bin/activate  # Linux/Mac
   pip install -r requirements.txt
   ```

3. Run the application:
   ```bash
   python desktop_launcher.py
   ```

4. *(Optional)* Build the executable:
   ```bash
   python build_exe.py
   ```
