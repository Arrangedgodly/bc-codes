import { useState, useEffect } from "react";
import validator from "validator";
import { updateRelease } from "../firebase";

const EditRelease = ({ release }: any) => {
  const [image, setImage] = useState<string>(release?.image);
  const [validImage, setValidImage] = useState<boolean>(
    validator.isURL(release?.image)
  );
  const [name, setName] = useState<string>(release?.name);
  const [artist, setArtist] = useState<string>(release?.artist);
  const [about, setAbout] = useState<string>(release?.about);
  const [redeemURL, setRedeemURL] = useState<string>(release?.redeemURL);
  const [validRedeemURL, setValidRedeemURL] = useState<boolean>(false);
  const [link, setlink] = useState<string>(release?.link);
  const [validlink, setValidlink] = useState<boolean>(false);
  const [slug, setSlug] = useState<string>(release?.slug);
  const [releaseDate, setReleaseDate] = useState<string>(release?.releaseDate);
  const [releaseType, setReleaseType] = useState<string>(release?.releaseType);
  const [codes, setCodes] = useState<string[]>(release?.codes);
  const [codeCount, setCodeCount] = useState<number>(release?.codes.length);
  const [canSubmit, setCanSubmit] = useState<boolean>(false);
  const [newRelease, setNewRelease] = useState<any>(null);

  const handleImageChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setImage(e.target.value);
  };

  const handleNameChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setName(e.target.value);
  };

  const handleArtistChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setArtist(e.target.value);
  };

  const handlelinkChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setlink(e.target.value);
  };

  const handleRedeemURLChange = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  useEffect(() => {
    setCodeCount(codes.length);
  }, [codes]);

  const areRequiredFieldsChanged = (): boolean => {
    const requiredFields = [image, redeemURL, link, releaseDate, releaseType];
    return requiredFields.every((field) => field !== "");
  };

  const updateModalState = () => {
    setImage(release?.image);
    setName(release?.name);
    setArtist(release?.artist);
    setAbout(release?.about);
    setRedeemURL(release?.redeemURL);
    setlink(release?.link);
    setReleaseDate(release?.releaseDate);
    setReleaseType(release?.releaseType);
    setCodes(release?.codes);
    setCodeCount(release?.codes.length);
  };

  useEffect(() => {
    if (areRequiredFieldsChanged()) {
      setCanSubmit(true);
    } else {
      setCanSubmit(false);
    }
  }, [image, redeemURL, link, releaseDate, releaseType]);

  useEffect(() => {
    updateModalState();
  }, [release]);

  const handleEditRelease = async (release: any) => {
    await updateRelease(release.id, release);
  };

  useEffect(() => {
    const newRelease = {
      id: release.id,
      name,
      codes,
      about,
      redeemURL,
      artist: artist ? artist : release.artist,
      link,
      image,
      releaseDate,
      releaseType,
      slug
    };
    setNewRelease(newRelease);
  }, [
    image,
    name,
    artist,
    about,
    redeemURL,
    link,
    releaseDate,
    releaseType,
    codes,
    slug
  ]);

  const checkImageValidity = () => {
    if (validator.isURL(image)) {
      setValidImage(true);
    } else {
      setValidImage(false);
    }
  }

  const checkLinkValidity = () => {
    if (validator.isURL(link)) {
      setValidlink(true);
    } else {
      setValidlink(false);
    }
  }

  const checkRedeemURLValidity = () => {
    if (validator.isURL(redeemURL)) {
      setValidRedeemURL(true);
    } else {
      setValidRedeemURL(false);
    }
  }

  useEffect(() => {
    checkImageValidity();
  }, [image]);

  useEffect(() => {
    checkLinkValidity();
  }, [link]);

  useEffect(() => {
    checkRedeemURLValidity();
  }, [redeemURL]);

  return (
    <>
      <input type="checkbox" id="edit_release" className="modal-toggle" />
      <div className="modal" role="dialog">
        <div className="modal-box glass">
          <h3 className="text-5xl font-bold">Edit Release</h3>
          <p className="text-2xl">* denotes required fields</p>
          {image && <img src={image} alt={name} className="w-full my-2" />}
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
              <span className="label-text text-3xl">Slug *</span>
              <span className="label-text-alt text-2xl">
                The URL identifier for your release
              </span>
            </label>
            <input
              type="text"
              placeholder="Slug"
              value={slug}
              className="input input-bordered text-2xl"
              onChange={(e) => setSlug(e.target.value)}
            />
            <label className="label">
              {slug.length > 0 && (
                <span className="label-text text-2xl italic">
                  Your release link will be codefanatics.app/release/{slug}
                </span>
              )}
            </label>
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
              htmlFor="edit_release"
              className={
                canSubmit
                  ? "btn btn-primary btn-lg text-2xl w-full"
                  : "btn btn-primary btn-disabled btn-lg text-2xl w-full"
              }
              onClick={() => handleEditRelease(newRelease)}
            >
              Save Release
            </label>
          </div>
        </div>
        <label className="modal-backdrop" htmlFor="edit_release">
          Close
        </label>
      </div>
    </>
  );
};

export default EditRelease;
