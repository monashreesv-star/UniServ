/**
 * ============================================================================
 * UniServ Navigation Reference
 * ============================================================================
 * Allows programmatic navigation from anywhere in the application
 * (e.g. PayPal return/cancel resolver, deep links, notifications).
 * ============================================================================
 */

import React from 'react';

export const navigationRef = React.createRef();

export function navigate(name, params) {
  if (navigationRef.current) {
    if (typeof navigationRef.current.isReady === 'function') {
      if (navigationRef.current.isReady()) {
        navigationRef.current.navigate(name, params);
        return true;
      }
    } else if (typeof navigationRef.current.navigate === 'function') {
      navigationRef.current.navigate(name, params);
      return true;
    }
  }
  return false;
}

export default {
  navigationRef,
  navigate
};
