import { Request, Response, NextFunction } from 'express';
import { config, getProjectsForToken, getTokenInfo } from '../config.js';

export interface AuthContext {
  token: string;
  name: string;
  allowedProjects: string[];
}

declare global {
  namespace Express {
    interface Request {
      authContext?: AuthContext;
    }
  }
}

const AUTH_HEADER = 'authorization';
const BEARER_PREFIX = 'Bearer ';

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers[AUTH_HEADER];

  if (!authHeader || typeof authHeader !== 'string') {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing Authorization header',
    });
    return;
  }

  if (!authHeader.startsWith(BEARER_PREFIX)) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid Authorization header format. Expected: Bearer <token>',
    });
    return;
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  
  if (!token) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing token in Authorization header',
    });
    return;
  }

  const tokenInfo = getTokenInfo(token);
  
  if (!tokenInfo) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Invalid or unknown token',
    });
    return;
  }

  const allowedProjects = getProjectsForToken(token);

  req.authContext = {
    token,
    name: tokenInfo.name,
    allowedProjects,
  };

  next();
}

export function optionalAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers[AUTH_HEADER];

  if (!authHeader || typeof authHeader !== 'string' || !authHeader.startsWith(BEARER_PREFIX)) {
    req.authContext = undefined;
    next();
    return;
  }

  const token = authHeader.slice(BEARER_PREFIX.length).trim();
  
  if (!token) {
    req.authContext = undefined;
    next();
    return;
  }

  const tokenInfo = getTokenInfo(token);
  
  if (!tokenInfo) {
    req.authContext = undefined;
    next();
    return;
  }

  const allowedProjects = getProjectsForToken(token);

  req.authContext = {
    token,
    name: tokenInfo.name,
    allowedProjects,
  };

  next();
}

export function buildAclFilter(authContext: AuthContext, requestedProject?: string): Record<string, unknown> {
  let allowedProjects: string[];

  if (requestedProject) {
    if (!authContext.allowedProjects.includes(requestedProject)) {
      throw new Error(`Access denied to project '${requestedProject}'`);
    }
    allowedProjects = [requestedProject];
  } else {
    allowedProjects = authContext.allowedProjects;
  }

  if (allowedProjects.length === 0) {
    throw new Error('No projects available for this token');
  }

  if (allowedProjects.length === 1) {
    return {
      must: [
        {
          key: 'project',
          match: { value: allowedProjects[0] },
        },
      ],
    };
  }

  return {
    must: [
      {
        key: 'project',
        match: { any: allowedProjects },
      },
    ],
  };
}

export function getAuthContext(req: Request): AuthContext | undefined {
  return req.authContext;
}

export function requireAuthContext(req: Request): AuthContext {
  const context = req.authContext;
  if (!context) {
    throw new Error('Authentication required');
  }
  return context;
}

export function requireAdminToken(token: string): void {
  // Check if token has admin privileges (access to all projects or special admin flag)
  const tokenInfo = getTokenInfo(token);
  
  if (!tokenInfo) {
    throw new Error('Invalid token');
  }

  // For now, we consider a token admin if it has '*' in projects or 'admin' in name
  const isAdmin = tokenInfo.projects.includes('*') || 
                  tokenInfo.name.toLowerCase().includes('admin');

  if (!isAdmin) {
    throw new Error('Admin privileges required');
  }
}

export function createCombinedFilter(
  aclFilter: Record<string, unknown>,
  additionalFilter?: Record<string, unknown>
): Record<string, unknown> {
  if (!additionalFilter) {
    return aclFilter;
  }

  const combinedMust: unknown[] = [];
  
  // Add ACL conditions
  if (aclFilter.must) {
    combinedMust.push(...(aclFilter.must as unknown[]));
  }

  // Add additional conditions
  if (additionalFilter.must) {
    combinedMust.push(...(additionalFilter.must as unknown[]));
  }

  return {
    must: combinedMust,
  };
}
