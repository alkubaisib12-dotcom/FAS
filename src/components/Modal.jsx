import React from 'react';

export default function Modal({ isOpen, onClose, children }) {
  if (!isOpen) return null;

  return (
    <div
      style={backdropStyle}
      onClick={(e) => { if (e.target === e.currentTarget && onClose) onClose(); }}
    >
      <div style={modalStyle}>
        {onClose && (
          <button onClick={onClose} style={closeBtnStyle} aria-label="Close">✕</button>
        )}
        {children}
      </div>
    </div>
  );
}

const backdropStyle = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  backgroundColor: 'rgba(0,0,0,0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000
};

const modalStyle = {
  position: 'relative',
  background: '#fff',
  padding: '20px',
  borderRadius: '8px',
  width: '90%',
  maxWidth: '900px',
  maxHeight: '90vh',
  overflowY: 'auto',
  boxShadow: '0 5px 15px rgba(0,0,0,0.3)'
};

const closeBtnStyle = {
  position: 'absolute',
  top: '10px',
  right: '12px',
  background: 'transparent',
  border: 'none',
  fontSize: '20px',
  lineHeight: 1,
  cursor: 'pointer',
  color: '#666',
  padding: '4px 8px',
  borderRadius: '4px'
};
