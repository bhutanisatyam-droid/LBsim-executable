# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['desktop_launcher.py'],
    pathex=[],
    binaries=[],
    datas=[('C:\\Users\\bhuta\\OneDrive\\Desktop\\lbsim-desktop\\frontend', 'frontend'), ('C:\\Users\\bhuta\\OneDrive\\Desktop\\lbsim-desktop\\backend', 'backend')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tensorflow', 'keras', 'torch', 'torchvision', 'torchaudio', 'scipy', 'numpy', 'pandas', 'matplotlib', 'sklearn', 'skimage', 'cv2', 'IPython', 'notebook', 'jupyter', 'h5py', 'lz4', 'fsspec', 'grpc', 'google', 'protobuf', 'pyarrow', 'sqlalchemy', 'boto3', 'botocore', 'docutils', 'pygments', 'babel', 'jinja2'],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='LBsim',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
