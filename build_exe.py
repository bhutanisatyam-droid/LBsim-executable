import PyInstaller.__main__
import os

# Get absolute paths to the frontend and backend folders
frontend_dir = os.path.abspath('frontend')
backend_dir  = os.path.abspath('backend')

# These are large ML/science libraries installed globally in Python 3.11
# that have nothing to do with LBSim. Explicitly exclude them so they don't
# get bundled and make the .exe unnecessarily huge.
EXCLUDES = [
    'tensorflow', 'keras', 'torch', 'torchvision', 'torchaudio',
    'scipy', 'numpy', 'pandas', 'matplotlib', 'sklearn', 'skimage',
    'cv2', 'IPython', 'notebook', 'jupyter',
    'h5py', 'lz4', 'fsspec', 'grpc', 'google', 'protobuf',
    'pyarrow', 'sqlalchemy', 'boto3', 'botocore',
    'docutils', 'pygments', 'babel', 'jinja2',
]

exclude_args = []
for pkg in EXCLUDES:
    exclude_args += ['--exclude-module', pkg]

PyInstaller.__main__.run([
    'desktop_launcher.py',
    '--name=LBsim',
    '--windowed',
    '--onefile',
    f'--add-data={frontend_dir}:frontend',   # bundle the HTML/JS/CSS UI files
    f'--add-data={backend_dir}:backend',     # bundle the backend/main.py server
    '--clean',
    *exclude_args,                           # exclude all irrelevant heavy packages
])
