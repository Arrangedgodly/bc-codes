import { useState, useEffect } from "react";

type PopupProps = {
  text: string;
  version: string;
};

const Popup: React.FC<PopupProps> = ({ text, version }) => {
  const [showPopup, setShowPopup] = useState<boolean>(true);
  const [popupClass, setPopupClass] = useState<string>("");

  useEffect(() => {
    const timer = setTimeout(() => {
      setShowPopup(false);
    }, 2000);

    return () => {
      clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (version === "success") {
      setPopupClass("alert alert-success");
    }
    if (version === "error") {
      setPopupClass("alert alert-error");
    }
    if (version === "warning") {
      setPopupClass("alert alert-warning");
    }
    if (version === "info") {
      setPopupClass("alert alert-info");
    }
  }, [version]);

  return (
    <>
      {showPopup && (
        <div className="toast toast-center bottom-[50px] z-50">
          <div className={popupClass}>
            <span className="small-text">{text}</span>
          </div>
        </div>
      )}
    </>
  )
};

export default Popup;
