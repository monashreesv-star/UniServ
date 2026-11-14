/**
 * ============================================================================
 * UniServ API Configuration
 * ============================================================================
 * Centralized configuration for the UniServ backend API.
 * ============================================================================
 */

export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:5000';

export default {
  API_BASE_URL
};
