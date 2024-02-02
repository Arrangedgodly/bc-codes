import { useState, useEffect } from "react";
import validator from "validator";
import { addRelease, getArtistDocument } from "../firebase";

type NewReleaseProps = {
  user: any;
  setUser: any;
};

const NewRelease: React.FC<NewReleaseProps> = ({ user, setUser }) => {
  const [image, setImage] = useState<string>("");
  const [validImage, setValidImage] = useState<boolean>(false);
  const [name, setName] = useState<string>("");
  const [artist, setArtist] = useState<string>("");
  const [about, setAbout] = useState<string>("");
  const [redeemURL, setRedeemURL] = useState<string>("");
  const [validRedeemURL, setValidRedeemURL] = useState<boolean>(false);
  const [link, setlink] = useState<string>("");
  const [validlink, setValidlink] = useState<boolean>(false);
  const [releaseDate, setReleaseDate] = useState<string>("");
  const [releaseType, setReleaseType] = useState<string>("");
  const [codes, setCodes] = useState<string[]>([]);
  const [codeCount, setCodeCount] = useState<number>(0);
  const [canSubmit, setCanSubmit] = useState<boolean>(false);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!validator.isURL(e.target.value)) {
      setValidImage(false);
    } else {
      setValidImage(true);
    }
    setImage(e.target.value);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  };

  const handleArtistChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setArtist(e.target.value);
  };

  const handlelinkChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!validator.isURL(e.target.value)) {
      setValidlink(false);
    } else {
      setValidlink(true);
    }
    setlink(e.target.value);
  };

  const handleRedeemURLChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!validator.isURL(e.target.value)) {
      setValidRedeemURL(false);
    } else {
      setValidRedeemURL(true);
    }
    setRedeemURL(e.target.value);
  };

  const handleReleaseDateChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setReleaseDate(e.target.value);
  };

  const handleReleaseTypeChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setReleaseType(e.target.value);
  };

  const handleCSVChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;
    const file = e.target.files[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = async (e) => {
        if (!e.target) return;
        const text = e.target.result as string;
        const lines = text.split("\n");
        const codeIndex = lines.indexOf("code");
        const codes = lines
          .slice(codeIndex + 1)
          .filter((line) => line.trim() !== "");
        setCodes(codes);
      };
      reader.readAsText(file);
    }
  };

  const handleAddRelease = async () => {
    const release = {
      name,
      codes,
      about,
      redeemURL,
      artist: artist ? artist : user.name,
      link,
      image,
      releaseDate,
      releaseType,
    };
    await addRelease(user.uid, release);
    setImage("");
    setName("");
    setArtist("");
    setAbout("");
    setRedeemURL("");
    setlink("");
    setReleaseDate("");
    setReleaseType("");
    setCodes([]);
    setCodeCount(0);
    setUser(await getArtistDocument(user.uid));
  };

  useEffect(() => {
    setCodeCount(codes.length);
  }, [codes]);

  const areRequiredFieldsChanged = (): boolean => {
    const requiredFields = [
      image,
      redeemURL,
      link,
      releaseDate,
      releaseType,
    ];
    return requiredFields.every((field) => field !== "");
  };

  useEffect(() => {
    if (areRequiredFieldsChanged()) {
      setCanSubmit(true);
    } else {
      setCanSubmit(false);
    }
  }, [image, redeemURL, link, releaseDate, releaseType]);

  return (
    <>
      <input type="checkbox" id="new_release" className="modal-toggle" />
      <div className="modal" role="dialog">
        <div className="modal-box glass">
          <h3 className="text-5xl font-bold">Add New Release</h3>
          <p className="text-2xl">* denotes required fields</p>
          {image && (
            <img src={image} alt={name} className="w-full my-2" />
          )}
          <div className="form-control my-2 w-full">
            <label className="label">
              <span className="label-text text-3xl">Image URL *</span>
            </label>
            <input
              type="text"
              placeholder="Image URL"
              value={image}
              className={
                validImage
                  ? "input input-success input-bordered text-2xl"
                  : "input input-error input-bordered text-2xl"
              }
              onChange={handleImageChange}
            />
          </div>
          <div className="form-control my-2 w-full">
            <label className="label">
              <span className="label-text text-3xl">name *</span>
            </label>
            <input
              type="text"
              placeholder="name"
              value={name}
              className="input input-bordered text-2xl"
              onChange={handleNameChange}
            />
          </div>
          <div className="form-control my-2 w-full">
            <label className="label">
              <span className="label-text text-3xl">About</span>
            </label>
            <textarea
              placeholder="About"
              value={about}
              className="textarea h-24 textarea-bordered text-2xl"
              onChange={(e) => setAbout(e.target.value)}
            ></textarea>
          </div>
          <div className="form-control my-2 w-full">
            <label className="label">
              <span className="label-text text-3xl">Artist</span>
              <span className="label-text-alt text-2xl">
                {" "}
                (if different from Artist/Label name)
              </span>
            </label>
            <input
              type="text"
              placeholder="Artist"
              value={artist}
              className="input input-bordered text-2xl"
              onChange={handleArtistChange}
            />
          </div>
          <div className="form-control my-2 w-full">
            <label className="label">
              <span className="label-text text-3xl">Bandcamp URL *</span>
            </label>
            <input
              type="text"
              placeholder="Bandcamp URL"
              value={link}
              className={
                validlink
                  ? "input input-success input-bordered text-2xl"
                  : "input input-error input-bordered text-2xl"
              }
              onChange={handlelinkChange}
            />
          </div>
          <div className="form-control my-2 w-full">
            <label className="label">
              <span className="label-text text-3xl">Redemption URL *</span>
            </label>
            <input
              type="text"
              placeholder="Redeem URL"
              value={redeemURL}
              className={
                validRedeemURL
                  ? "input input-success input-bordered text-2xl"
                  : "input input-error input-bordered text-2xl"
              }
              onChange={handleRedeemURLChange}
            />
          </div>
          <div className="form-control my-2 w-full">
            <label className="label">
              <span className="label-text text-3xl">Release Date *</span>
            </label>
            <input
              type="date"
              placeholder="Release Date"
              value={releaseDate}
              className="input input-bordered text-2xl"
              onChange={handleReleaseDateChange}
            />
          </div>
          <label className="label">
            <span className="label-text text-3xl">Release Type *</span>
          </label>
          <select
            className="select select-bordered w-full my-2 text-xl"
            onChange={handleReleaseTypeChange}
          >
            <option disabled value={releaseType}>
              Release Type
            </option>
            <option>Single</option>
            <option>EP</option>
            <option>LP</option>
            <option>Sample Pack</option>
            <option>Compilation</option>
            <option>Soundtrack</option>
            <option>Mixtape</option>
            <option>Remix</option>
            <option>Demo</option>
            <option>Other</option>
          </select>
          <label className="label">
            <span className="label-text text-3xl">Codes CSV</span>
          </label>
          <div className="indicator w-full">
            {codeCount > 0 && (
              <span className="indicator-item indicator-center indicator-bottom badge badge-secondary text-2xl p-3">
                {codeCount} codes
              </span>
            )}
            <input
              type="file"
              className="file-input file-input-bordered text-2xl my-2 w-full"
              onChange={handleCSVChange}
            />
          </div>
          <div className="modal-action">
            <label
              htmlFor="new_release"
              className={canSubmit ? "btn btn-primary btn-lg text-2xl w-full" : "btn btn-primary btn-disabled btn-lg text-2xl w-full"}
              onClick={handleAddRelease}
            >
              Add Release
            </label>
          </div>
        </div>
        <label className="modal-backdrop" htmlFor="new_release">
          Close
        </label>
      </div>
    </>
  );
};

export default NewRelease;
