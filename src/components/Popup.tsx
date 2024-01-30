import { useState, useEffect } from "react";

type PopupProps = {
  text: string;
};

const Popup: React.FC<PopupProps> = ({ text }) => {
  const [showPopup, setShowPopup] = useState<boolean>(true);

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowPopup(false);
    }, 2000);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  return (
    <>
      {showPopup && (
        <div className="toast toast-center bottom-[50px] z-50">
          <div className="alert alert-success">
            <span className="small-text">{text}</span>
          </div>
        </div>
      )}
    </>
  )
};

export default Popup;
