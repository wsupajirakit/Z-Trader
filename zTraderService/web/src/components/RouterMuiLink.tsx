import MuiLink, { type LinkProps } from '@mui/material/Link';
import { createLink } from '@tanstack/react-router';
import { forwardRef } from 'react';

const Base = forwardRef<HTMLAnchorElement, LinkProps>(
  function Base(props, ref) {
    return <MuiLink ref={ref} underline="hover" {...props} />;
  },
);

/** MUI-styled link with TanStack Router's typed `to` / `params` */
// createLink returns a component; the fast-refresh rule cannot see through the factory

export const RouterMuiLink = createLink(Base);
