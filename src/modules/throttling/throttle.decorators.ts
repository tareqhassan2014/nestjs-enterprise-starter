import { SetMetadata } from '@nestjs/common';

/** Marks a controller/route for the stricter Nest throttle ceilings. */
export const STRICT_THROTTLE_KEY = 'throttle:strict';

export const StrictThrottle = (): ClassDecorator & MethodDecorator =>
  SetMetadata(STRICT_THROTTLE_KEY, true);
