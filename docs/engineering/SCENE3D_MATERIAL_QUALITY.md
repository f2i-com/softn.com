# Scene3D material quality

`Scene3D` supports optional studio image-based lighting and AgX tone mapping:

```xml
<Scene3D
  objects={objects}
  lights={lights}
  camera={camera}
  environment="studio"
  environmentIntensity={0.7}
  toneMapping="agx"
  toneMappingExposure={1}
  antialias={true}
  maxPixelRatio={2}
/>
```

The built-in studio environment is generated locally with Three.js PMREM; it does not fetch an HDR image. It supplies reflections and indirect material lighting without replacing the scene background. Environment intensity updates without rebuilding the map, and disabling the environment or unmounting releases the render target. Intensity is clamped to 0–4 and exposure to 0–8. Existing defaults remain ACES with no environment.

Imported materials receive anisotropic filtering capped at the GPU's supported value and at 8x. Opaque alpha-tested materials use alpha-to-coverage for smoother foliage/hair cutouts when MSAA is enabled. Transparent materials keep their blend/depth behavior. Imported texture colour spaces and normal maps remain under GLTFLoader's control.

AgX provides a colour-management option closer to modern Blender previews. It does not reproduce Cycles: match camera, exposure, lighting, roughness, normal maps and exported materials separately. Procedural Blender shaders, subdivision, simulation and unexported geometry are not reconstructed. High pixel ratios increase GPU cost; 1–1.5 remains useful on slower devices.

Validation: 12 focused component tests cover orbit target orientation, environment lifetime, intensity updates, AgX/exposure updates, cutout materials and filtering limits. Components and web production builds pass. A real SoftN bundle with metal and rough dielectric spheres exercises the studio environment in the browser; no application-specific assets are included here.
