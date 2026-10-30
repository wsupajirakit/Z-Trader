import Logout from '@mui/icons-material/Logout';
import PersonOutlined from '@mui/icons-material/PersonOutlined';
import Box from '@mui/material/Box';
import Button from '@mui/material/Button';
import Divider from '@mui/material/Divider';
import ListItemIcon from '@mui/material/ListItemIcon';
import Menu from '@mui/material/Menu';
import MenuItem from '@mui/material/MenuItem';
import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { useCurrentUser } from '../features/auth/session';
import { useLogout } from '../features/auth/useLogout';

export function UserMenu() {
  const user = useCurrentUser();
  const logout = useLogout();
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  if (!user) return null;
  return (
    <>
      <Button
        color="inherit"
        aria-label="User menu"
        onClick={(e) => {
          setAnchor(e.currentTarget);
        }}
        sx={{ textTransform: 'none', letterSpacing: 0, gap: 1.5, px: 1.5 }}
      >
        <Box
          sx={{
            width: 22,
            height: 22,
            borderRadius: '50%',
            bgcolor: 'terminal.panelAlt',
            border: 1,
            borderColor: 'divider',
            display: 'grid',
            placeItems: 'center',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {user.username.slice(0, 1).toUpperCase()}
        </Box>
        <Box
          sx={{
            display: { xs: 'none', lg: 'block' },
            textAlign: 'left',
            lineHeight: 1.1,
          }}
        >
          <Box sx={{ fontSize: 11.5 }}>{user.name}</Box>
          <Box
            sx={{
              fontSize: 9.5,
              color: 'text.secondary',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
            }}
          >
            {user.role}
          </Box>
        </Box>
      </Button>
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => {
          setAnchor(null);
        }}
      >
        <MenuItem
          onClick={() => {
            setAnchor(null);
            void navigate({ to: '/account' });
          }}
        >
          <ListItemIcon>
            <PersonOutlined fontSize="small" />
          </ListItemIcon>
          My account
        </MenuItem>
        <Divider />
        <MenuItem
          disabled={logout.isPending}
          onClick={() => {
            setAnchor(null);
            logout.mutate();
          }}
        >
          <ListItemIcon>
            <Logout fontSize="small" />
          </ListItemIcon>
          Log out
        </MenuItem>
      </Menu>
    </>
  );
}
