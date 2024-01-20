import { useState } from "react";

const RedeemedRelease = ({ release }: any) => {
  const [codeRevealed, setCodeRevealed] = useState<boolean>(false);

  const handleCodeReveal = () => {
    setCodeRevealed(true);
    navigator.clipboard.writeText(release.code);
  };

  return (
    <div className="card max-w-[150px] bg-base-100 shadow-xl image-full m-5">
      <figure>
        <img src={release.image} alt={release.name} />
      </figure>
      <div className="justify-end card-body text-center">
        <h2 className="card-title m-auto text-xl">{release.name}</h2>
        {codeRevealed ? (
          <p className="text-2xl">{release.code}</p>
        ) : (
          <div
            className="tooltip tooltip-secondary"
            data-tip="Click to Reveal/Copy the Code"
          >
            <button
              className="btn btn-accent btn-sm"
              onClick={handleCodeReveal}
            >
              My Code
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default RedeemedRelease;
