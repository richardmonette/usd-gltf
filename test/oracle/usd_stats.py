"""Reference statistics for USD files, computed with Pixar's OpenUSD.

For every rendered Mesh: triangle count and world space bounds (meters, Y up) at a few
times, after baking skinning. Usage: python usd_stats.py out.json file.usdz [...]
"""
import sys, json, math
from pxr import Usd, UsdGeom, UsdSkel, UsdValidation, Gf


def correction(stage):
    m = Gf.Matrix4d(1)
    if UsdGeom.GetStageUpAxis(stage) == 'Z':
        m = Gf.Matrix4d(1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1)
    mpu = UsdGeom.GetStageMetersPerUnit(stage)
    return Gf.Matrix4d().SetScale(Gf.Vec3d(mpu, mpu, mpu)) * m


def sample_times(stage):
    start, end = stage.GetStartTimeCode(), stage.GetEndTimeCode()
    if end <= start:
        return [start]
    # the middle sample is snapped to an authored time sample: between samples, baked
    # skinning is interpolated linearly, which differs from evaluating the skeleton there
    mid = (start + end) / 2
    keys = set()
    for prim in stage.Traverse():
        for attr in prim.GetAttributes():
            if attr.GetNumTimeSamples() > 1:
                keys.update(attr.GetTimeSamples())
    if keys:
        mid = min(keys, key=lambda t: abs(t - mid))
    return sorted({start, mid, end})


def validate(path):
    registry = UsdValidation.ValidationRegistry()
    context = UsdValidation.ValidationContext(registry.GetOrLoadAllValidators())
    issues = context.Validate(Usd.Stage.Open(path))
    return {
        'errors': [f'{e.GetName()}: {e.GetMessage()}' for e in issues if e.GetType() == UsdValidation.ValidationErrorType.Error],
        'warnings': [f'{e.GetName()}: {e.GetMessage()}' for e in issues if e.GetType() == UsdValidation.ValidationErrorType.Warn],
    }


def stats(path):
    # validate first: BakeSkinning edits the shared in-memory layers
    checks = validate(path) if CHECK else {}
    stage = Usd.Stage.Open(path)
    times = sample_times(stage)
    skinned = any(p.IsA(UsdSkel.Root) for p in stage.Traverse())
    if skinned:
        UsdSkel.BakeSkinning(stage.Traverse(), Gf.Interval(times[0], times[-1]))
    fix = correction(stage)
    meshes = {}
    for prim in stage.Traverse():
        if not (prim.IsA(UsdGeom.Mesh) or prim.IsA(UsdGeom.Points) or prim.IsA(UsdGeom.BasisCurves)):
            continue
        img = UsdGeom.Imageable(prim)
        if img.ComputePurpose() not in ('default', 'render'):
            continue
        mesh = UsdGeom.PointBased(prim)
        if prim.IsA(UsdGeom.Mesh):
            counts = UsdGeom.Mesh(prim).GetFaceVertexCountsAttr().Get() or []
            holes = set(UsdGeom.Mesh(prim).GetHoleIndicesAttr().Get() or [])
            tris = sum(max(0, c - 2) for i, c in enumerate(counts) if i not in holes)
            if tris == 0:
                continue
        else:
            tris = 0
        boxes = {}
        for t in times:
            pts = mesh.GetPointsAttr().Get(t)
            if not pts:
                continue
            m = img.ComputeLocalToWorldTransform(t) * fix
            lo = [math.inf] * 3
            hi = [-math.inf] * 3
            fvi = UsdGeom.Mesh(prim).GetFaceVertexIndicesAttr().Get() if prim.IsA(UsdGeom.Mesh) else None
            used = set(fvi) if fvi is not None else range(len(pts))
            for i in used:
                if i >= len(pts):
                    continue
                w = m.Transform(Gf.Vec3d(pts[i]))
                for k in range(3):
                    lo[k] = min(lo[k], w[k])
                    hi[k] = max(hi[k], w[k])
            boxes[str(t)] = [lo, hi]
        meshes[str(prim.GetPath())] = {
            'triangles': tris,
            'visible': img.ComputeVisibility() != UsdGeom.Tokens.invisible,
            'bounds': boxes,
        }
    result = {
        'timeCodesPerSecond': stage.GetTimeCodesPerSecond(),
        'startTimeCode': stage.GetStartTimeCode(),
        'times': times,
        'meshes': meshes,
        **checks,
    }
    return result


CHECK = '--check' in sys.argv


if __name__ == '__main__':
    out = {}
    for f in [a for a in sys.argv[2:] if a != '--check']:
        try:
            out[f] = stats(f)
        except Exception as e:
            out[f] = {'error': str(e)}
    json.dump(out, open(sys.argv[1], 'w'), indent=1)
